import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import { BytesLike, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers"

import { IAccountHub, IAccountHubHook__factory, MockAccountHubHook } from "../src/types"
import { initializeFixture } from "./Initialize.fixture"
import { ethers } from "./helpers/hardhat-connection"
import { loadFixture } from "./helpers/network-helpers"
import { PositionType } from "./models/Enums"
import { Hedger } from "./models/Hedger"
import { RunContext } from "./models/RunContext"
import { User } from "./models/User"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest"
import { decimal } from "./utils/Common"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils"

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

	function createSubAccountData(
		name: string,
		isolationType: number,
		metadata: string = "0x",
		singleVAMode: boolean = false,
	): IAccountHub.SubAccountCreationDataStruct {
		return {
			name,
			metadata: ethers.keccak256(toUtf8Bytes(metadata)),
			symmioCore: context.diamond,
			isolationType,
			singleVAMode,
		}
	}

	async function createSubAccountAndDeposit(
		parentAccount: HardhatEthersSigner,
		subAccountData: IAccountHub.SubAccountCreationDataStruct[],
		depositAmount: bigint,
		allocateToo: boolean = false,
	) {
		await context.accountHub.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
		const accounts = await context.accountHubLens.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
		const sAcc = accounts[accounts.length - 1]

		await context.collateral.connect(parentAccount).approve(await context.accountFacet.getAddress(), depositAmount)
		if (allocateToo) {
			await context.accountFacet.connect(parentAccount).depositAndAllocateFor(sAcc, depositAmount)
		} else {
			await context.accountFacet.connect(parentAccount).depositFor(sAcc, depositAmount)
		}

		return sAcc
	}

	async function sendQuoteAndGetVirtualAccount(account: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		// Check if this is a virtual account or a sub-account
		const virtualAccountData = await context.accountHubLens.getVirtualAccount(account)

		if (virtualAccountData.isExists) {
			// It's an existing VA - fund it directly using addMargin
			const marginNeeded = decimal(500n)
			await context.accountHub.connect(context.signers.user).addMargin(account, marginNeeded)
		} else {
			// It's a sub-account
			const subAccountData = await context.accountHubLens.getSubAccount(account)
			const isolationType = subAccountData.isolationType

			// For non-CUSTOM isolation, we need to fund the VA before sendQuote using addMarginToNextVA
			if (isolationType !== 3n) {
				// 3 = CUSTOM
				// Determine the virtual account isolation type
				let vaIsolationType: number
				if (isolationType === 0n) {
					// POSITION
					vaIsolationType = 0 // VirtualAccountIsolationType.POSITION
				} else if (isolationType === 1n) {
					// MARKET
					vaIsolationType = 1 // VirtualAccountIsolationType.MARKET
				} else {
					// MARKET_DIRECTION (2)
					vaIsolationType = quoteRequest.positionType === PositionType.LONG ? 2 : 3 // MARKET_LONG or MARKET_SHORT
				}

				// Fund the predicted VA address with enough margin using the new addMarginToNextVA method
				const marginNeeded = decimal(500n) // cva + lf + partyAmm + buffer for fees
				await context.accountHub.connect(context.signers.user).addMarginToNextVA(account, vaIsolationType, quoteRequest.symbolId, marginNeeded)
			}
		}

		const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
		await context.accountHub.connect(context.signers.user)._call(account, [sendQuoteCallData])

		// If it was a sub-account, return its VAs; if it was a VA, return empty
		if (!virtualAccountData.isExists) {
			const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(account, 0, 10)
			return virtualAccountsAfter
		}
		return []
	}

	async function preFundVirtualAccount(subAccount: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		const subAccountData = await context.accountHubLens.getSubAccount(subAccount)
		const isolationType = subAccountData.isolationType

		if (isolationType === 3n) return // CUSTOM doesn't create VA

		let vaIsolationType: number
		if (isolationType === 0n) {
			vaIsolationType = 0
		} else if (isolationType === 1n) {
			vaIsolationType = 1
		} else {
			vaIsolationType = quoteRequest.positionType === PositionType.LONG ? 2 : 3
		}

		// Use the new addMarginToNextVA method to pre-fund the VA
		const marginNeeded = decimal(500n)
		await context.accountHub.connect(context.signers.user).addMarginToNextVA(subAccount, vaIsolationType, quoteRequest.symbolId, marginNeeded)
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
		const quotes = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
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
		TRANSFER_AMOUNT: decimal(500n),
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
			const buildExampleSubAccountData = (): IAccountHub.SubAccountCreationDataStruct[] => [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]

			it("should create subAccount successfully", async () => {
				const subAccountData = buildExampleSubAccountData()
				const oldNonce = await context.accountHub.globalNonce()
				let newNonce = oldNonce
				await expect(context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)).to
					.not.reverted

				const subAccountAddresses = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)

				if (subAccountAddresses.length != subAccountData.length) {
					throw Error("invalid length of account creation result")
				}

				for (let i = 0; i < subAccountAddresses.length; i++) {
					const acc = await context.accountHubLens.getSubAccount(subAccountAddresses[i])
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
				const subAccountData = {
					name: "EXAMPLE_NAME",
					metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
					symmioCore: context.signers.others[0].address,
					isolationType: 0,
					singleVAMode: false,
				}
				await expect(
					context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), [subAccountData]),
				).to.revertedWithCustomError(context.accountHub, "NotSymmioCore")
			})

			it("should failed when provided affiliate not active", async () => {
				const subAccountData = buildExampleSubAccountData()
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
				const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
				subAccountAddress = accounts[0]
			})

			it("should edit subAccount name successfully", async () => {
				const accBeforeEdit = await context.accountHubLens.getSubAccount(subAccountAddress)

				await expect(context.accountHub.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.not.reverted

				const accAfterEdit = await context.accountHubLens.getSubAccount(subAccountAddress)
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

		describe("setSingleVAMode", async () => {
			describe("basic functionality", async () => {
				it("should allow enabling singleVAMode on MARKET isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					// Initially singleVAMode should be false
					let subAccountDetail = await context.accountHubLens.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.false

					// Enable singleVAMode
					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(marketSubAccount, true))
						.to.emit(context.accountHub, "SingleVAModeChanged")
						.withArgs(marketSubAccount, true)

					// Verify it's enabled
					subAccountDetail = await context.accountHubLens.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
				})

				it("should allow enabling singleVAMode on MARKET_DIRECTION isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("MARKET_DIR_ACCOUNT", 2, "MARKET_DIR", false)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketDirSubAccount = accounts[accounts.length - 1]

					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(marketDirSubAccount, true))
						.to.emit(context.accountHub, "SingleVAModeChanged")
						.withArgs(marketDirSubAccount, true)

					const subAccountDetail = await context.accountHubLens.getSubAccount(marketDirSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
				})

				it("should allow disabling singleVAMode", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", true)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					// Initially singleVAMode should be true (set during creation)
					let subAccountDetail = await context.accountHubLens.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true

					// Disable singleVAMode
					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(marketSubAccount, false))
						.to.emit(context.accountHub, "SingleVAModeChanged")
						.withArgs(marketSubAccount, false)

					subAccountDetail = await context.accountHubLens.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.false
				})

				it("should create sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("MARKET_SINGLE_VA", 1, "MARKET", true)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					const subAccountDetail = await context.accountHubLens.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
					expect(subAccountDetail.isolationType).to.equal(1) // MARKET
				})
			})

			describe("validation", async () => {
				it("should revert when enabling singleVAMode on POSITION isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("POSITION_ACCOUNT", 0, "POSITION", false)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const positionSubAccount = accounts[accounts.length - 1]

					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(positionSubAccount, true)).to.revertedWithCustomError(
						context.accountHub,
						"SingleVAModeNotApplicable",
					)
				})

				it("should revert when enabling singleVAMode on CUSTOM isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("CUSTOM_ACCOUNT", 3, "CUSTOM", false)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const customSubAccount = accounts[accounts.length - 1]

					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(customSubAccount, true)).to.revertedWithCustomError(
						context.accountHub,
						"SingleVAModeNotApplicable",
					)
				})

				it("should revert when creating POSITION sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("POSITION_SINGLE", 0, "POSITION", true)]
					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.revertedWithCustomError(context.accountHub, "SingleVAModeNotApplicable")
				})

				it("should revert when creating CUSTOM sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("CUSTOM_SINGLE", 3, "CUSTOM", true)]
					await expect(
						context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.revertedWithCustomError(context.accountHub, "SingleVAModeNotApplicable")
				})

				it("should revert when non-owner tries to set singleVAMode", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					await expect(context.accountHub.connect(context.signers.others[0]).setSingleVAMode(marketSubAccount, true)).to.revertedWithCustomError(
						context.accountHub,
						"NotOwner",
					)
				})

				it("should revert when sub-account does not exist", async () => {
					await expect(
						context.accountHub.connect(context.signers.user).setSingleVAMode(context.signers.others[0].address, true),
					).to.revertedWithCustomError(context.accountHub, "NotOwner")
				})

				it("should revert when changing singleVAMode with active virtual accounts", async () => {
					// Create MARKET sub-account without singleVAMode
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					const marketSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					// Send a quote to create a virtual account (sendQuoteAndGetVirtualAccount handles funding)
					const quoteRequest = limitQuoteRequestBuilder().build()
					await sendQuoteAndGetVirtualAccount(marketSubAccount, quoteRequest)

					// Verify VA was created
					const vaCount = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketSubAccount)
					expect(vaCount).to.equal(1)

					// Try to enable singleVAMode - should fail
					await expect(context.accountHub.connect(context.signers.user).setSingleVAMode(marketSubAccount, true)).to.revertedWithCustomError(
						context.accountHub,
						"HasActiveVirtualAccounts",
					)
				})
			})

			describe("singleVAMode behavior with MARKET isolation", async () => {
				let marketSubAccount: string

				beforeEach(async () => {
					// Create MARKET sub-account with singleVAMode enabled
					const subAccountData = [createSubAccountData("SINGLE_VA_MARKET", 1, "MARKET", true)]
					marketSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
				})

				it("should reuse the same VA for multiple quotes on the same symbol", async () => {
					// Send first quote (sendQuoteAndGetVirtualAccount handles funding)
					const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const virtualAccounts1 = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)

					expect(virtualAccounts1.length).to.equal(1)
					const firstVA = virtualAccounts1[0]

					// Check activeVAByKey
					const activeVA = await context.accountHubLens.getActiveVAByKey(marketSubAccount, 1, 1) // MARKET=1, symbolId=1
					expect(activeVA).to.equal(firstVA)

					// Fund the VA again for another quote (add margin to existing VA)
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(firstVA, decimal(500n))

					// Send second quote for same symbol 1 (singleVAMode should reuse existing VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
					const callData2 = await createSendQuoteCallData(quote2)
					await context.accountHub.connect(context.signers.user)._call(marketSubAccount, [callData2])

					// Should still have only 1 VA
					const virtualAccounts2 = await context.accountHubLens.getVirtualAccountsOfSubAccount(marketSubAccount, 0, 10)
					expect(virtualAccounts2.length).to.equal(1)
					expect(virtualAccounts2[0].accountAddress).to.equal(firstVA)

					// VA should have 2 quotes
					const quoteIds = await context.accountHubLens.getVirtualAccountQuoteIds(firstVA, 0, 10)
					expect(quoteIds.length).to.equal(2)
				})

				it("should create separate VAs for different symbols", async () => {
					// Send quote for symbol 1
					const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const virtualAccounts1 = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)

					expect(virtualAccounts1.length).to.equal(1)
					const va1 = virtualAccounts1[0]

					// Fund sub-account again for second VA
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(marketSubAccount, BALANCES.DEPOSIT_AMOUNT)

					// Send quote for symbol 2 (should create new VA since different symbol)
					const quote2 = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.LONG).build()
					const virtualAccounts2After = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote2)

					// Should have 2 VAs now
					expect(virtualAccounts2After.length).to.equal(2)

					// Check both VAs are tracked in activeVAByKey
					const activeVA1 = await context.accountHubLens.getActiveVAByKey(marketSubAccount, 1, 1) // MARKET=1, symbolId=1
					const activeVA2 = await context.accountHubLens.getActiveVAByKey(marketSubAccount, 1, 2) // MARKET=1, symbolId=2
					expect(activeVA1).to.equal(va1)
					expect(activeVA2).to.not.equal(ZeroAddress)
					expect(activeVA1).to.not.equal(activeVA2)
				})
			})

			describe("singleVAMode behavior with MARKET_DIRECTION isolation", async () => {
				let marketDirSubAccount: string

				beforeEach(async () => {
					// Create MARKET_DIRECTION sub-account with singleVAMode enabled
					const subAccountData = [createSubAccountData("SINGLE_VA_MARKET_DIR", 2, "MARKET_DIR", true)]
					marketDirSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
				})

				it("should reuse the same VA for multiple quotes on the same symbol and direction", async () => {
					// Send first LONG quote for symbol 1
					const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const virtualAccounts1 = await sendQuoteAndGetVirtualAccount(marketDirSubAccount, quote1)

					expect(virtualAccounts1.length).to.equal(1)
					const longVA = virtualAccounts1[0]

					// Check activeVAByKey for MARKET_LONG (type 2)
					const activeLongVA = await context.accountHubLens.getActiveVAByKey(marketDirSubAccount, 2, 1) // MARKET_LONG=2, symbolId=1
					expect(activeLongVA).to.equal(longVA)

					// Fund the VA again for another quote
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(longVA, decimal(500n))

					// Send second LONG quote for same symbol (singleVAMode should reuse existing VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const callData2 = await createSendQuoteCallData(quote2)
					await context.accountHub.connect(context.signers.user)._call(marketDirSubAccount, [callData2])

					// Should still have only 1 VA
					const virtualAccounts2 = await context.accountHubLens.getVirtualAccountsOfSubAccount(marketDirSubAccount, 0, 10)
					expect(virtualAccounts2.length).to.equal(1)
					expect(virtualAccounts2[0].accountAddress).to.equal(longVA)
				})

				it("should create separate VAs for different directions on the same symbol", async () => {
					// Send LONG quote for symbol 1
					const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const virtualAccounts1 = await sendQuoteAndGetVirtualAccount(marketDirSubAccount, quote1)

					expect(virtualAccounts1.length).to.equal(1)
					const longVA = virtualAccounts1[0]

					// Fund sub-account again for second VA
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(marketDirSubAccount, BALANCES.DEPOSIT_AMOUNT)

					// Send SHORT quote for same symbol (different direction should create new VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
					const virtualAccounts2After = await sendQuoteAndGetVirtualAccount(marketDirSubAccount, quote2)

					// Should have 2 VAs now (one LONG, one SHORT)
					expect(virtualAccounts2After.length).to.equal(2)

					// Check both directions are tracked
					const activeLongVA = await context.accountHubLens.getActiveVAByKey(marketDirSubAccount, 2, 1) // MARKET_LONG=2
					const activeShortVA = await context.accountHubLens.getActiveVAByKey(marketDirSubAccount, 3, 1) // MARKET_SHORT=3
					expect(activeLongVA).to.equal(longVA)
					expect(activeShortVA).to.not.equal(ZeroAddress)
					expect(activeLongVA).to.not.equal(activeShortVA)
				})
			})

			describe("singleVAMode disabled behavior (default)", async () => {
				let marketSubAccount: string

				beforeEach(async () => {
					// Create MARKET sub-account WITHOUT singleVAMode
					const subAccountData = [createSubAccountData("MULTI_VA_MARKET", 1, "MARKET", false)]
					marketSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
				})

				it("should create new VA for each quote even on the same symbol when singleVAMode is disabled", async () => {
					// Send first quote for symbol 1
					const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const virtualAccounts1 = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)

					expect(virtualAccounts1.length).to.equal(1)

					// Fund sub-account again for second VA
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(marketSubAccount, BALANCES.DEPOSIT_AMOUNT)

					// Send another quote for same symbol (without singleVAMode, should create new VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
					const virtualAccounts2 = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote2)

					// Should have 2 VAs (no reuse when singleVAMode is disabled)
					expect(virtualAccounts2.length).to.equal(2)

					// activeVAByKey should be empty when singleVAMode is disabled
					const activeVA = await context.accountHubLens.getActiveVAByKey(marketSubAccount, 1, 1)
					expect(activeVA).to.equal(ZeroAddress)
				})
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
						const virtualAccountsBefore = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(positionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(positionSubAccount)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(positionSubAccount)
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
						const virtualAccountsBefore = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(marketSubAccount)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketSubAccount)
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

						// Add more funds to VA for the second quote
						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(200n))
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], decimal(200n))

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketSubAccount)
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
						const virtualAccountsBefore = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(marketDirectionSubAccount, quoteRequest)

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])).to.not.be.reverted

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
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

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
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
						const virtualAccountsBefore = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])).to.not.reverted

						// Verify no virtual accounts were created
						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
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
						const virtualAccounts = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
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
						const virtualAccountsBefore = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccountsAfter = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccounts = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
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

						const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds from sub-account to virtual account (cva + lf + partyAmm + fees)
						const transferAmount = decimal(500n)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, transferAmount])

						await expect(context.accountHub.connect(context.signers.user)._call(customSubAccount, [transferCallData])).to.not.reverted

						const virtualAccountBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
						expect(virtualAccountBalance).to.equal(transferAmount)

						// Send quote from virtual account
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await expect(context.accountHub.connect(context.signers.user)._call(virtualAccount, [sendQuoteCallData])).to.not.reverted

						const quoteIds = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
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

						const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds (cva + lf + partyAmm + fees)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(500n)])
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

						const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds (cva + lf + partyAmm + fees)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(500n)])
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
						const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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

						const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						expect(virtualAccounts.length).to.equal(2)

						const btcLongVirtual = virtualAccounts[0].accountAddress
						const ethShortVirtual = virtualAccounts[1].accountAddress

						// Transfer funds to both (cva + lf + partyAmm + fees)
						const transferToBtc = context.accountFacet.interface.encodeFunctionData("internalTransfer", [btcLongVirtual, decimal(500n)])
						const transferToEth = context.accountFacet.interface.encodeFunctionData("internalTransfer", [ethShortVirtual, decimal(500n)])

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
						const btcQuotes = await context.accountHubLens.getVirtualAccountQuoteIds(btcLongVirtual, 0, 10)
						const ethQuotes = await context.accountHubLens.getVirtualAccountQuoteIds(ethShortVirtual, 0, 10)

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

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const quotesAfterClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHubLens.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("Should add the removed virtualAccount to deletedVirtualAccountsPool for reuse", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const deletedAccountData = await context.accountHubLens.getVirtualAccount(initialVirtualAccountAddress)
				expect(deletedAccountData.isExists).to.false

				// Send new quote to trigger virtual account reuse
				const reusedVirtualAccountAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const reusedVirtualAccountAddress = reusedVirtualAccountAddresses[0]

				expect(reusedVirtualAccountAddress).to.equal(initialVirtualAccountAddress)
				expect(await context.accountHubLens.getVirtualAccountsCountOfSubAccount(positionSubAccountAddress)).to.equal(1)

				const reusedAccountData = await context.accountHubLens.getVirtualAccount(reusedVirtualAccountAddress)
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

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)

				await cancelVirtualAccountQuote(virtualAccountAddress)

				const quotesAfterClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.accountHubLens.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})
		})

		describe("Fund return to parent balance on virtual account deletion", async () => {
			let positionSubAccountAddress: string

			beforeEach(async () => {
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
			})

			it("Should transfer funds to parent balance (not allocatedBalance) when virtual account is deleted", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				// Get parent's balance and allocatedBalance before closing
				const parentBalanceBefore = await context.viewFacet.balanceOf(positionSubAccountAddress)
				const parentAllocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(positionSubAccountAddress)

				// Open and close the position
				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				// Virtual account should be deleted
				const virtualAccountData = await context.accountHubLens.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				// Funds should return to parent's BALANCE, not allocatedBalance
				const parentBalanceAfter = await context.viewFacet.balanceOf(positionSubAccountAddress)
				const parentAllocatedAfter = await context.viewFacet.allocatedBalanceOfPartyA(positionSubAccountAddress)

				// Parent's balance should increase (funds returned from virtual account)
				expect(parentBalanceAfter).to.be.gt(parentBalanceBefore)

				// Parent's allocatedBalance should remain unchanged (funds don't go to allocatedBalance)
				expect(parentAllocatedAfter).to.equal(parentAllocatedBefore)
			})

			it("Should allow immediate creation of new virtual account with returned funds", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				// Open and close to return funds to parent
				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				// Parent should have balance (not allocatedBalance), so can immediately create new virtual account
				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)

				// Should be able to create a new virtual account immediately without needing to deallocate
				const newQuoteRequest = limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()
				const newVirtualAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, newQuoteRequest)
				expect(newVirtualAddresses.length).to.equal(1)

				const newVirtualAccountData = await context.accountHubLens.getVirtualAccount(newVirtualAddresses[0])
				expect(newVirtualAccountData.isExists).to.true
			})

			it("Should set withdrawCooldown on parent when funds are returned", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				// Open and close to return funds
				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				// Parent's withdrawCooldown should be set
				const cooldown = await context.viewFacet.withdrawCooldownOf(positionSubAccountAddress)
				expect(cooldown).to.be.gt(0n)
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

					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
				const buildCustomSubAccountData = () => [createSubAccountData("CUSTOM_ACCOUNT", 3)]

				it("should call onVirtualAccountCreation when virtual account is auto-created", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onVirtualAccountCreation when manually creating virtual account", async () => {
					const subAccountData = buildCustomSubAccountData()
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
					const subAccountData = buildCustomSubAccountData()
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const customAccount = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					// Create 3 virtual accounts
					for (let i = 0; i < 3; i++) {
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
					const quotes = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
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

					const virtualAccountData = await context.accountHubLens.getVirtualAccount(virtualAccountAddress)
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

					const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(marketAccount, 0, 10)
					const marketVirtualAccount = virtualAccounts[0].accountAddress

					await sendQuoteAndGetVirtualAccount(marketVirtualAccount)

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Cancel only first quote
					await cancelVirtualAccountQuote(marketVirtualAccount)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Hook should not be called because virtual account still has one quote
					expect(callCountAfter).to.equal(callCountBefore)

					// Virtual account should still exist
					const virtualAccountData = await context.accountHubLens.getVirtualAccount(marketVirtualAccount)
					expect(virtualAccountData.isExists).to.be.true
				})

				it("should handle hook revert gracefully during deletion", async () => {
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, "Hook rejected deletion")

					const quotes = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Should revert because hook rejects
					await expect(
						context.accountHub.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote]),
					).to.be.revertedWithCustomError(context.accountHub, "HookFailed")
				})

				it("should return the hook failure reason for virtual account deletion", async () => {
					const revertMessage = "Deletion blocked: account has pending rewards"

					const quotes = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
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
					const addresses = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user2.address, 0, 100)
					expect(addresses).to.be.an("array").that.is.empty
				})

				it("should return correct sub-account addresses for owner", async function () {
					const addresses = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses.length).to.be.greaterThanOrEqual(1)
				})

				it("should return multiple sub-accounts when created", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					const secondSubAccount = await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const addresses = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses).to.include(secondSubAccount)
				})
			})

			describe("getSubAccount", async () => {
				it("should return correct sub-account details", async function () {
					const detail = await context.accountHubLens.getSubAccount(subAccountAddress)

					expect(detail.accountAddress).to.equal(subAccountAddress)
					expect(detail.owner).to.equal(context.signers.user.address)
					expect(detail.name).to.equal("GETTER_TEST_ACCOUNT")
					expect(detail.affiliate).to.equal(await context.accountManager.getAddress())
					expect(detail.symmioCore).to.equal(context.diamond)
				})
			})

			describe("getUserSubAccounts", async () => {
				it("should return empty array if no sub-accounts exist", async function () {
					const details = await context.accountHubLens.getUserSubAccounts(context.signers.others[0].address, 0, 10)
					expect(details.length).to.be.equal(0)
				})

				it("should return paginated sub-account details", async function () {
					const details = await context.accountHubLens.getUserSubAccounts(context.signers.user.address, 0, 10)

					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(subAccountAddress)
				})

				it("should respect offset and limit", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const allDetails = await context.accountHubLens.getUserSubAccounts(context.signers.user.address, 0, 10)
					const firstOnly = await context.accountHubLens.getUserSubAccounts(context.signers.user.address, 0, 1)
					const secondOnly = await context.accountHubLens.getUserSubAccounts(context.signers.user.address, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return empty array when no virtual accounts exist", async function () {
					const details = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should return virtual account details after quote", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
				})
			})

			describe("getVirtualAccount", async () => {
				it("should return correct virtual account details", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const detail = await context.accountHubLens.getVirtualAccount(virtualAccountAddress)

					expect(detail.accountAddress).to.equal(virtualAccountAddress)
					expect(detail.parentAccount).to.equal(subAccountAddress)
					expect(detail.isExists).to.equal(true)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return paginated virtual account details", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
				})

				it("should return empty array if no virtual accounts exist", async function () {
					const details = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should respect offset and limit", async function () {
					// Create two virtual accounts
					await sendQuoteAndGetVirtualAccount(subAccountAddress)
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const allDetails = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					const firstOnly = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 1)
					const secondOnly = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
					expect(allDetails[0].accountAddress).to.equal(firstOnly[0].accountAddress)
					expect(allDetails[1].accountAddress).to.equal(secondOnly[0].accountAddress)
				})

				it("should return correct details for each virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					const details = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
					expect(details[0].parentAccount).to.equal(subAccountAddress)
					expect(details[0].isExists).to.be.true
				})
			})

			describe("sendQuoteAndGetVirtualAccount", async () => {
				it("should return quote IDs for virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const quoteIds = await context.accountHubLens.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					expect(quoteIds.length).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getSubAccountsCountOfUser", async () => {
				it("should return 0 for user with no sub-accounts", async function () {
					const count = await context.accountHubLens.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(count).to.equal(0)
				})

				it("should return correct count after creating sub-accounts", async function () {
					const count = await context.accountHubLens.getSubAccountsCountOfUser(context.signers.user.address)
					expect(count).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getVirtualAccountsCountOfSubAccount", async () => {
				it("should return 0 when no virtual accounts exist", async function () {
					const count = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(count).to.equal(0)
				})

				it("should return correct count after sending quote", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const count = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(subAccountAddress)
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

			describe("AccountManager.getAccounts", async () => {
				it("should return empty array when user has no accounts", async function () {
					const accounts = await context.accountManager.getAccounts(context.signers.user2.address, 0, 100)
					expect(accounts.length).to.equal(0)
				})

				it("should return correct accounts for a user", async function () {
					// beforeEach creates 1 account, create 2 more for total of 3
					const subAccountData = [createSubAccountData("ACCOUNT_1", 0), createSubAccountData("ACCOUNT_2", 0)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.accountManager.getAccounts(context.signers.user.address, 0, 100)
					expect(accounts.length).to.equal(3)

					// Verify these are the same as what AccountHub returns
					const hubAccounts = await context.accountHubLens.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(accounts.map(a => a.accountAddress)).to.deep.equal(hubAccounts)
				})

				it("should respect pagination with start and size", async function () {
					// beforeEach creates 1 account, create 4 more for total of 5
					const subAccountData = [
						createSubAccountData("PAGE_1", 0),
						createSubAccountData("PAGE_2", 0),
						createSubAccountData("PAGE_3", 0),
						createSubAccountData("PAGE_4", 0),
					]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					// Get first 2 accounts
					const firstPage = await context.accountManager.getAccounts(context.signers.user.address, 0, 2)
					expect(firstPage.length).to.equal(2)

					// Get accounts starting from index 2, size 2
					const secondPage = await context.accountManager.getAccounts(context.signers.user.address, 2, 2)
					expect(secondPage.length).to.equal(2)

					// Get accounts starting from index 4, size 2 (only 1 remaining)
					const lastPage = await context.accountManager.getAccounts(context.signers.user.address, 4, 2)
					expect(lastPage.length).to.equal(1)

					// Verify no overlap between pages
					expect(firstPage[0].accountAddress).to.not.equal(secondPage[0].accountAddress)
					expect(secondPage[0].accountAddress).to.not.equal(lastPage[0].accountAddress)
				})

				it("should return empty array when start exceeds total accounts", async function () {
					// beforeEach already creates 1 account
					const accounts = await context.accountManager.getAccounts(context.signers.user.address, 10, 100)
					expect(accounts.length).to.equal(0)
				})
			})

			describe("AccountManager.getAccountsLength", async () => {
				it("should return 0 when user has no accounts", async function () {
					const length = await context.accountManager.getAccountsLength(context.signers.user2.address)
					expect(length).to.equal(0)
				})

				it("should return correct count of accounts", async function () {
					// beforeEach creates 1 account, create 2 more for total of 3
					const subAccountData = [createSubAccountData("LEN_1", 0), createSubAccountData("LEN_2", 0)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const length = await context.accountManager.getAccountsLength(context.signers.user.address)
					expect(length).to.equal(3)
				})

				it("should return different counts for different users", async function () {
					// beforeEach creates 1 account for user, create 1 more for total of 2
					const userSubAccountData = [createSubAccountData("USER_1", 0)]
					await context.accountHub.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), userSubAccountData)

					// Create 1 account for user2
					const user2SubAccountData = [createSubAccountData("USER2_1", 0)]
					await context.accountHub.connect(context.signers.user2).createSubAccounts(await context.accountManager.getAddress(), user2SubAccountData)

					const lengthUser1 = await context.accountManager.getAccountsLength(context.signers.user.address)
					const lengthUser2 = await context.accountManager.getAccountsLength(context.signers.user2.address)

					expect(lengthUser1).to.equal(2)
					expect(lengthUser2).to.equal(1)
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

					const totalCount = await context.accountHubLens.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(totalCount).to.equal(TOTAL_ACCOUNTS)

					// Test various batch sizes
					const batch100 = await context.accountHubLens.getUserSubAccounts(context.signers.user2.address, 0, 100)
					expect(batch100.length).to.equal(100)
					expect(batch100[0].owner).to.equal(context.signers.user2.address)

					const batch500 = await context.accountHubLens.getUserSubAccounts(context.signers.user2.address, 0, 500)
					expect(batch500.length).to.equal(500)

					// Test pagination through all accounts
					let retrievedCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.accountHubLens.getUserSubAccounts(context.signers.user2.address, offset, pageSize)
						retrievedCount += batch.length

						// Verify first item in each batch
						if (batch.length > 0) {
							expect(batch[0].owner).to.equal(context.signers.user2.address)
						}
					}

					expect(retrievedCount).to.equal(TOTAL_ACCOUNTS)

					// Test offset functionality
					const firstBatch = await context.accountHubLens.getUserSubAccounts(context.signers.user2.address, 0, 10)
					const secondBatch = await context.accountHubLens.getUserSubAccounts(context.signers.user2.address, 10, 10)
					expect(firstBatch[0].accountAddress).to.not.equal(secondBatch[0].accountAddress)
				})
			})

			describe("Large Dataset Virtual Accounts Batch Retrieval", async () => {
				// Helper to create a CUSTOM sub-account without deposit (for virtual account creation tests)
				async function createCustomSubAccountWithoutDeposit(parentAccount: HardhatEthersSigner, name: string): Promise<string> {
					const subAccountData = [createSubAccountData(name, 3)] // isolationType 3 = CUSTOM
					await context.accountHub.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.accountHubLens.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
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

							await context.accountHub
								.connect(context.signers.user2)
								.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes(`VIRTUAL_${j}`)), isolationType, symbolId)
						}
					}

					// Verify total count
					const totalCount = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(customSubAccount)
					expect(totalCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test getVirtualAccountsAddressesOfSubAccount with various batch sizes
					const addresses100 = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 100)
					expect(addresses100.length).to.equal(100)

					const addresses500 = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 500)
					expect(addresses500.length).to.equal(500)

					// Test getVirtualAccountsOfSubAccount with detailed info
					const details100 = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 100)
					expect(details100.length).to.equal(100)
					expect(details100[0].parentAccount).to.equal(customSubAccount)
					expect(details100[0].isExists).to.be.true

					// Test pagination through all virtual accounts using addresses
					let retrievedAddressCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_VIRTUAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, offset, pageSize)
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
						const batch = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, offset, pageSize)
						retrievedDetailCount += batch.length

						// Verify each item in batch has correct parent
						for (const detail of batch) {
							expect(detail.parentAccount).to.equal(customSubAccount)
							expect(detail.isExists).to.be.true
						}
					}

					expect(retrievedDetailCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test offset functionality for addresses
					const firstAddressBatch = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 10)
					const secondAddressBatch = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 10, 10)
					expect(firstAddressBatch[0]).to.not.equal(secondAddressBatch[0])

					// Test offset functionality for details
					const firstDetailBatch = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
					const secondDetailBatch = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 10, 10)
					expect(firstDetailBatch[0].accountAddress).to.not.equal(secondDetailBatch[0].accountAddress)

					// Verify getVirtualAccount for individual accounts
					const sampleAddress = addresses100[50]
					const sampleDetail = await context.accountHubLens.getVirtualAccount(sampleAddress)
					expect(sampleDetail.parentAccount).to.equal(customSubAccount)
					expect(sampleDetail.isExists).to.be.true

					// Test boundary conditions
					// Offset at end should return empty array
					const emptyBatch = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS, 100)
					expect(emptyBatch.length).to.equal(0)

					// Offset near end should return remaining accounts
					const nearEndBatch = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS - 50, 100)
					expect(nearEndBatch.length).to.equal(50)

					// Verify getSubAccountVirtualNonce
					const nonce = await context.accountHubLens.getSubAccountVirtualNonce(customSubAccount)
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

						await context.accountHub
							.connect(context.signers.user2)
							.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes(`VERIFY_${i}`)), isolationType, symbolId)
					}

					// Retrieve all and verify
					const allDetails = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, TOTAL_VIRTUAL_ACCOUNTS)
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
					const predictedAddress = await context.accountHubLens.predictNextVirtualAccountAddress(
						customSubAccount,
						0, // POSITION
						TOTAL_VIRTUAL_ACCOUNTS + 1,
					)
					expect(predictedAddress).to.not.equal(ZeroAddress)

					// Create the predicted account
					await context.accountHub
						.connect(context.signers.user2)
						.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes("PREDICTED")), 0, TOTAL_VIRTUAL_ACCOUNTS + 1)

					// Verify the actual address matches prediction
					const allAddresses = await context.accountHubLens.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS, 1)
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
							await context.accountHub
								.connect(context.signers.user2)
								.createCustomVirtualAccount(
									subAccountAddresses[subIdx],
									ethers.keccak256(toUtf8Bytes(`SUB_${subIdx}_VIRT_${virtIdx}`)),
									virtIdx % 4,
									(virtIdx % 5) + 1,
								)
						}
					}

					// Verify counts for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						const count = await context.accountHubLens.getVirtualAccountsCountOfSubAccount(subAccountAddresses[subIdx])
						expect(count).to.equal(VIRTUAL_ACCOUNTS_PER_SUB)
					}

					// Verify user's total sub-accounts
					const userSubAccountCount = await context.accountHubLens.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(userSubAccountCount).to.equal(NUM_SUB_ACCOUNTS)

					// Test pagination for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						let totalRetrieved = 0
						const pageSize = 100

						for (let offset = 0; offset < VIRTUAL_ACCOUNTS_PER_SUB; offset += pageSize) {
							const batch = await context.accountHubLens.getVirtualAccountsOfSubAccount(subAccountAddresses[subIdx], offset, pageSize)
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
				const currentNonce = await context.accountHubLens.getSubAccountVirtualNonce(positionSubAccountAddress)

				// Predict the next virtual account address
				const predictedAddress = await context.accountHubLens.predictNextVirtualAccountAddress(
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
				const newNonce = await context.accountHubLens.getSubAccountVirtualNonce(positionSubAccountAddress)
				expect(newNonce).to.equal(currentNonce + 1n)
			})

			it("should return deleted virtual account address when one exists", async () => {
				// Create a virtual account
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const initialVirtualAccount = virtualAccounts[0]

				// Close the position to delete the virtual account
				const quotes = await context.accountHubLens.getVirtualAccountQuoteIds(initialVirtualAccount, 0, 10)
				const quoteId = quotes[0]
				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccount)

				// Verify the virtual account was deleted
				const deletedAccountData = await context.accountHubLens.getVirtualAccount(initialVirtualAccount)
				expect(deletedAccountData.isExists).to.false

				// Predict the next virtual account address
				const predictedAddress = await context.accountHubLens.predictNextVirtualAccountAddress(
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
				const predictedMarketAddress = await context.accountHubLens.predictNextVirtualAccountAddress(
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
				const predictedPositionAddress = await context.accountHubLens.predictNextVirtualAccountAddress(
					marketSubAccount,
					0, // VirtualAccountIsolationType.POSITION
					0, // symbolId 0 for position
				)

				// The addresses should be different for different isolation types
				expect(predictedPositionAddress).to.not.equal(predictedMarketAddress)
			})
		})

		describe("Transfer Methods", async () => {
			let customSubAccount: string
			let virtualAccount: string

			beforeEach(async () => {
				customSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CUSTOM_ACCOUNT", 3, "CUSTOM")],
					BALANCES.DEPOSIT_AMOUNT,
					false,
				)

				await context.accountHub.connect(context.signers.user).createCustomVirtualAccount(
					customSubAccount,
					ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
					0, // POSITION isolation
					1, // symbolId
				)

				const virtualAccounts = await context.accountHubLens.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
				virtualAccount = virtualAccounts[0].accountAddress
			})
			describe("addMargin", async () => {
				it("should transfer balance from subaccount to virtual account", async () => {
					// Check initial balances
					const subAccountBalanceBefore = await context.viewFacet.balanceOf(customSubAccount)
					const virtualAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(subAccountBalanceBefore).to.equal(BALANCES.DEPOSIT_AMOUNT)
					expect(virtualAccountAllocatedBalanceBefore).to.equal(0n)

					// Transfer from subaccount to virtual account
					await expect(context.accountHub.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT))
						.to.emit(context.accountHub, "AddMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					// Check balances after transfer
					const subAccountBalanceAfter = await context.viewFacet.balanceOf(customSubAccount)
					const virtualAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore - BALANCES.TRANSFER_AMOUNT)
					expect(virtualAccountAllocatedBalanceAfter).to.equal(BALANCES.TRANSFER_AMOUNT)
				})

				it("should revert when transferring zero amount", async () => {
					await expect(context.accountHub.connect(context.signers.user).addMargin(virtualAccount, 0n)).to.be.revertedWithCustomError(
						context.accountHub,
						"ZeroAmount",
					)
				})

				it("should revert when caller is not the account owner", async () => {
					await expect(
						context.accountHub.connect(context.signers.user2).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT),
					).to.be.revertedWithCustomError(context.accountHub, "NotOwner")
				})
			})

			describe("removeMargin", async () => {
				beforeEach(async () => {
					await context.accountHub.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT)
				})

				it("should transfer balance from virtual account to subaccount", async () => {
					// Check initial balances
					const subAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					const virtualAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					// Virtual account should have balance from the deposit
					expect(virtualAccountAllocatedBalanceBefore).to.equal(BALANCES.TRANSFER_AMOUNT)

					// Transfer from virtual account to subaccount
					await expect(
						context.accountHub.connect(context.signers.user).removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig()),
					)
						.to.emit(context.accountHub, "RemoveMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					// Check balances after transfer
					const virtualAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
					expect(virtualAccountAllocatedBalanceAfter).to.equal(0)

					const subAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					expect(subAccountAllocatedBalanceAfter).to.equal(subAccountAllocatedBalanceBefore + BALANCES.TRANSFER_AMOUNT)
				})

				it("should revert when transferring zero amount", async () => {
					await expect(
						context.accountHub.connect(context.signers.user).removeMargin(virtualAccount, 0n, await getDummySingleUpnlSig()),
					).to.be.revertedWithCustomError(context.accountHub, "ZeroAmount")
				})

				it("should revert when caller is not the account owner", async () => {
					await expect(
						context.accountHub.connect(context.signers.user2).removeMargin(virtualAccount, decimal(100n), await getDummySingleUpnlSig()),
					).to.be.revertedWithCustomError(context.accountHub, "NotOwner")
				})
			})

			describe("Round-trip transfer", async () => {
				it("should correctly handle transfers in both directions", async () => {
					const initialSubAccountBalance = await context.viewFacet.balanceOf(customSubAccount)
					const initialVirtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(initialSubAccountBalance).to.equal(BALANCES.DEPOSIT_AMOUNT)
					expect(initialVirtualAccountAllocatedBalance).to.equal(0n)

					// Step 1: Transfer from subaccount to virtual account
					await context.accountHub.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT)

					let subAccountBalance = await context.viewFacet.balanceOf(customSubAccount)
					let virtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(subAccountBalance).to.equal(BALANCES.DEPOSIT_AMOUNT - BALANCES.TRANSFER_AMOUNT)
					expect(virtualAccountAllocatedBalance).to.equal(BALANCES.TRANSFER_AMOUNT)

					// Step 2: Transfer from virtual account to subaccount
					await context.accountHub.connect(context.signers.user).removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig())

					virtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
					const subAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)

					expect(virtualAccountAllocatedBalance).to.equal(0)
					expect(subAccountAllocatedBalance).to.equal(BALANCES.TRANSFER_AMOUNT)
				})
			})
		})
	})
}
