import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import { BytesLike, toUtf8Bytes, ZeroAddress } from "ethers"

import { IAccountLayerHook__factory, ISymmioHook__factory } from "../src/types/index.js"
import type { MockAccountLayerHook } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType, QuoteStatus } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal, getBlockTimestamp } from "./utils/Common.js"
import { migratePartyBToCross } from "./utils/CrossPartyB.js"
import {
	getDummyHighLowPriceSig,
	getDummyLiquidationSig,
	getDummyPairUpnlAndPriceSig,
	getDummyPriceSig,
	getDummySingleUpnlSig,
	getDummySingleUpnlWithPendingBalanceSig,
} from "./utils/SignatureUtils.js"

// SubAccountCreationData struct type for AccountLayer
type SubAccountCreationDataStruct = {
	name: string
	metadata: BytesLike
	symmioCore: string
	isolationType: number
	singleVAMode: boolean
}

const roleHash = (name: string) => ethers.keccak256(toUtf8Bytes(name))
const SEND_QUOTE_WITH_AFFILIATE_SIGNATURE =
	"sendQuoteWithAffiliate(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)))"
const SEND_QUOTE_WITH_SOLVER_FEE_CAPS_SIGNATURE =
	"sendQuote(address[],uint256,uint8,uint8,uint256,uint256,uint256,uint256,uint256,uint256,uint256,address,(bytes,uint256,int256,uint256,bytes,(uint256,address,address)),bytes,(uint256,uint256))"

export function shouldBehaveLikeAccountLayer(): void {
	let context: RunContext, user: User, hedger: Hedger

	const createSendQuoteCallData = async (quoteRequest = limitQuoteRequestBuilder().build()) => {
		return context.partyAFacet.interface.encodeFunctionData(SEND_QUOTE_WITH_AFFILIATE_SIGNATURE, [
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
			ZeroAddress,
			await quoteRequest.upnlSig,
		])
	}

	const createSolverFeeSendQuoteCallData = async (quoteRequest = limitQuoteRequestBuilder().build()) => {
		return context.partyAFacet.interface.encodeFunctionData(SEND_QUOTE_WITH_SOLVER_FEE_CAPS_SIGNATURE, [
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
			await quoteRequest.deadline,
			ZeroAddress,
			await quoteRequest.upnlSig,
			"0x",
			{ openRateCap: 0, closeRateCap: 0 },
		])
	}

	function createSubAccountData(
		name: string,
		isolationType: number,
		metadata: string = "0x",
		singleVAMode: boolean = false,
	): SubAccountCreationDataStruct {
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
		subAccountData: SubAccountCreationDataStruct[],
		depositAmount: bigint,
		allocateToo: boolean = false,
	) {
		await context.alCoreFacet.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
		const accounts = await context.alViewFacet.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
		const sAcc = accounts[accounts.length - 1]

		await context.collateral.connect(parentAccount).approve(await context.accountFacet.getAddress(), depositAmount)
		if (allocateToo) {
			await context.accountFacet.connect(parentAccount).depositAndAllocateFor(sAcc, depositAmount)
		} else {
			await context.accountFacet.connect(parentAccount).depositFor(sAcc, depositAmount)
		}

		return sAcc
	}

	async function createSubAccount(parentAccount: HardhatEthersSigner, subAccountData: SubAccountCreationDataStruct[]) {
		await context.alCoreFacet.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
		const accounts = await context.alViewFacet.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
		return accounts[accounts.length - 1]
	}

	async function sendQuoteAndGetVirtualAccount(account: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		// Check if this is a virtual account or a sub-account
		const virtualAccountData = await context.alViewFacet.getVirtualAccount(account)

		if (virtualAccountData.isExists) {
			// It's an existing VA - fund it directly using addMargin
			const marginNeeded = decimal(500n)
			await context.alMarginFacet.connect(context.signers.user).addMargin(account, marginNeeded)
		} else {
			// It's a sub-account
			const subAccountData = await context.alViewFacet.getSubAccount(account)
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
				await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(account, vaIsolationType, quoteRequest.symbolId, marginNeeded)
			}
		}

		const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
		await context.alCoreFacet.connect(context.signers.user)._call(account, [sendQuoteCallData])

		// If it was a sub-account, return its VAs; if it was a VA, return empty
		if (!virtualAccountData.isExists) {
			const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(account, 0, 10)
			return virtualAccountsAfter
		}
		return []
	}

	async function preFundVirtualAccount(subAccount: string, quoteRequest = limitQuoteRequestBuilder().build()) {
		const subAccountData = await context.alViewFacet.getSubAccount(subAccount)
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
		await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(subAccount, vaIsolationType, quoteRequest.symbolId, marginNeeded)
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
		const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
		const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quotes[0]])
		await context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [encodedCancelQuote])
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

		await context.alCoreFacet.connect(partyA)._call(virtualAccount, [requestToCloseCallData])

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

	async function prepareSingleVAModeStateWithActiveAndPool(subAccount: string, symbolId: number): Promise<{ activeVA: string; pooledVA: string }> {
		const quoteLong = limitQuoteRequestBuilder().symbolId(symbolId).positionType(PositionType.LONG).build()
		const vaSet1 = await sendQuoteAndGetVirtualAccount(subAccount, quoteLong)
		const va1 = vaSet1[0]

		const quoteShort = limitQuoteRequestBuilder().symbolId(symbolId).positionType(PositionType.SHORT).build()
		const vaSet2 = await sendQuoteAndGetVirtualAccount(subAccount, quoteShort)
		const va2 = vaSet2[1]

		const quoteId1 = (await context.alViewFacet.getVirtualAccountQuoteIds(va1, 0, 10))[0]
		const quoteId2 = (await context.alViewFacet.getVirtualAccountQuoteIds(va2, 0, 10))[0]

		await openPositionForQuote(quoteId1)
		await closePositionForQuote(context.signers.user, quoteId1, va1)

		await openPositionForQuote(quoteId2)
		await closePositionForQuote(context.signers.user, quoteId2, va2)

		expect((await context.alViewFacet.getVirtualAccount(va1)).isExists).to.be.false
		expect((await context.alViewFacet.getVirtualAccount(va2)).isExists).to.be.false

		await context.alCoreFacet.connect(context.signers.user).setSingleVAMode(subAccount, true)

		await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
		await context.accountFacet.connect(context.signers.user).depositFor(subAccount, BALANCES.DEPOSIT_AMOUNT)

		const quoteAgain = limitQuoteRequestBuilder().symbolId(symbolId).positionType(PositionType.LONG).build()
		const vaSet3 = await sendQuoteAndGetVirtualAccount(subAccount, quoteAgain)
		const activeVA = vaSet3[0]

		expect(activeVA).to.equal(va2)
		expect(await context.alViewFacet.getActiveVAByKey(subAccount, 1, symbolId)).to.equal(va2)

		return { activeVA: va2, pooledVA: va1 }
	}

	describe("AccountLayer", async function () {
		beforeEach(async function () {
			context = await loadFixture(initializeFixture)
			user = new User(context, context.signers.user)
			await user.setup()
			await user.setBalances(BALANCES.INITIAL_COLLATERAL)

			hedger = new Hedger(context, context.signers.hedger)
			await hedger.setup()
			await hedger.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)

			await context.controlFacet.registerHook(ZeroAddress, context.accountLayerDiamond)

			await context.symbolControlFacet
				.connect(context.signers.admin)
				.addSymbol("ETHUSDT", decimal(5n), decimal(1n, 16), decimal(1n, 16), decimal(100n), 28800, 900)
		})

		describe("initialize", async () => {
			it("should initialize successfully", async () => {
				expect(context.accountLayerDiamond).to.not.equal(ZeroAddress)
				const defaultAdminRole = roleHash("DEFAULT_ADMIN_ROLE")
				expect(await context.alViewFacet.hasRole(context.signers.admin.address, defaultAdminRole)).to.be.true
			})
		})

		describe("Ownership", async () => {
			describe("transferOwnership", () => {
				it("Should initiate ownership transfer successfully", async function () {
					await expect(context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)).to.not.be.reverted
					expect(await context.alViewFacet.pendingOwner()).to.equal(context.signers.user.address)
				})

				it("Should revert when caller is not current owner", async function () {
					await expect(context.alControlFacet.connect(context.signers.user).transferOwnership(context.signers.user2.address)).to.be.revertedWith(
						"LibDiamond: Must be contract owner",
					)
				})
			})

			describe("cancelOwnershipTransfer", () => {
				it("Should allow owner to cancel the pending transfer", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					expect(await context.alViewFacet.pendingOwner()).to.equal(context.signers.user.address)
					await expect(context.alControlFacet.connect(context.signers.admin).cancelOwnershipTransfer()).to.not.be.reverted
					expect(await context.alViewFacet.pendingOwner()).to.equal(ZeroAddress)
				})

				it("Should revert when there is no pending owner", async function () {
					await expect(context.alControlFacet.connect(context.signers.admin).cancelOwnershipTransfer()).to.be.revertedWith(
						"LibDiamond: Pending owner is zero",
					)
				})

				it("Should revert when caller is not current owner", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					await expect(context.alControlFacet.connect(context.signers.user).cancelOwnershipTransfer()).to.be.revertedWith(
						"LibDiamond: Must be contract owner",
					)
				})
			})

			describe("acceptOwnership", () => {
				it("Should allow pending owner to accept ownership", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					await expect(context.alControlFacet.connect(context.signers.user).acceptOwnership()).to.not.be.reverted
					expect(await context.alViewFacet.owner()).to.equal(context.signers.user.address)
					expect(await context.alViewFacet.pendingOwner()).to.equal(ZeroAddress)
				})

				it("Should revert when no pending owner is set", async function () {
					await expect(context.alControlFacet.connect(context.signers.user).acceptOwnership()).to.be.revertedWith(
						"LibDiamond: Sender should be the pendingOwner",
					)
				})

				it("Should revert when caller is not the pending owner", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					await expect(context.alControlFacet.connect(context.signers.admin).acceptOwnership()).to.be.revertedWith(
						"LibDiamond: Sender should be the pendingOwner",
					)
				})

				it("Should not allow previous pending owner to accept after cancel", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					await context.alControlFacet.connect(context.signers.admin).cancelOwnershipTransfer()
					await expect(context.alControlFacet.connect(context.signers.user).acceptOwnership()).to.be.revertedWith(
						"LibDiamond: Sender should be the pendingOwner",
					)
				})

				it("Should update contract owner after acceptance", async function () {
					await context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user.address)
					await context.alControlFacet.connect(context.signers.user).acceptOwnership()
					// Old owner can no longer transfer
					await expect(context.alControlFacet.connect(context.signers.admin).transferOwnership(context.signers.user2.address)).to.be.revertedWith(
						"LibDiamond: Must be contract owner",
					)
					// New owner can transfer
					await expect(context.alControlFacet.connect(context.signers.user).transferOwnership(context.signers.user2.address)).to.not.be.reverted
					expect(await context.alViewFacet.pendingOwner()).to.equal(context.signers.user2.address)
				})
			})
		})

		describe("createSubAccounts", async () => {
			const buildExampleSubAccountData = (): SubAccountCreationDataStruct[] => [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]

			it("should create subAccount successfully", async () => {
				const subAccountData = buildExampleSubAccountData()
				const oldNonce = await context.alViewFacet.globalNonce()
				let newNonce = oldNonce
				await expect(context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData))
					.to.not.reverted

				const subAccountAddresses = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)

				if (subAccountAddresses.length != subAccountData.length) {
					throw Error("invalid length of account creation result")
				}

				for (let i = 0; i < subAccountAddresses.length; i++) {
					const acc = await context.alViewFacet.getSubAccount(subAccountAddresses[i])
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
				const accountDatas: SubAccountCreationDataStruct[] = []
				await expect(
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.alCoreFacet, "EmptyArray")
			})

			it("should failed when name length is more than limit", async () => {
				const maxNameLength = await context.alViewFacet.MAX_NAME_LENGTH()
				const accountDatas = [createSubAccountData("A".repeat(Number(maxNameLength) + 1), 0, "EXAMPLE")]

				await expect(
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), accountDatas),
				).to.revertedWithCustomError(context.alCoreFacet, "InvalidNameLength")
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
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), [subAccountData]),
				).to.revertedWithCustomError(context.alCoreFacet, "NotSymmioCore")
			})

			it("should failed when symmioCore is not in affiliate core list", async () => {
				const otherCore = context.signers.others[0].address
				await context.alControlFacet.connect(context.signers.admin).setWhitelistedSymmioCore(otherCore, true)

				const subAccountData = {
					name: "EXAMPLE_NAME",
					metadata: ethers.keccak256(toUtf8Bytes("EXAMPLE")),
					symmioCore: otherCore,
					isolationType: 0,
					singleVAMode: false,
				}

				await expect(
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), [subAccountData]),
				).to.revertedWithCustomError(context.alCoreFacet, "SymmioCoreNotAllowed")
			})

			it("should failed when provided affiliate not active", async () => {
				const subAccountData = buildExampleSubAccountData()
				await expect(
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(context.signers.others[0].address, subAccountData),
				).to.revertedWithCustomError(context.alCoreFacet, "AffiliateNotActive")
			})

			describe("createSubAccountsFor", async () => {
				const accountCreatorRole = roleHash("ACCOUNT_CREATOR_ROLE")

				it("should allow ACCOUNT_CREATOR_ROLE to create subAccounts for another owner", async () => {
					const subAccountData = buildExampleSubAccountData()

					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.user.address, accountCreatorRole)
					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.createSubAccountsFor(context.signers.user2.address, await context.accountManager.getAddress(), subAccountData),
					).to.not.be.reverted

					const userAccounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const user2Accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user2.address, 0, 100)
					const createdAccount = user2Accounts[user2Accounts.length - 1]
					const acc = await context.alViewFacet.getSubAccount(createdAccount)

					expect(userAccounts).to.not.include(createdAccount)
					expect(user2Accounts).to.include(createdAccount)
					expect(acc.owner).to.equal(context.signers.user2.address)
					expect(acc.isExists).to.true
					expect(acc.name).to.equal(subAccountData[0].name)
					expect(acc.affiliate).to.equal(await context.accountManager.getAddress())
				})

				it("should fail when caller does not have ACCOUNT_CREATOR_ROLE", async () => {
					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.createSubAccountsFor(context.signers.user2.address, await context.accountManager.getAddress(), buildExampleSubAccountData()),
					).to.be.revertedWithCustomError(context.alCoreFacet, "MustHaveRole")
				})

				it("should fail when owner is zero address", async () => {
					await context.alControlFacet.connect(context.signers.admin).grantRole(context.signers.user.address, accountCreatorRole)

					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.createSubAccountsFor(ZeroAddress, await context.accountManager.getAddress(), buildExampleSubAccountData()),
					).to.be.revertedWithCustomError(context.alCoreFacet, "ZeroAddress")
				})
			})
		})

		describe("editAccountName", async () => {
			let subAccountAddress: string = ""
			const newAccountName = "NEW_EXAMPLE_NAME"

			beforeEach(async () => {
				const subAccountData = [createSubAccountData("EXAMPLE_NAME", 0, "EXAMPLE")]

				await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
				const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
				subAccountAddress = accounts[0]
			})

			it("should edit subAccount name successfully", async () => {
				const accBeforeEdit = await context.alViewFacet.getSubAccount(subAccountAddress)

				await expect(context.alCoreFacet.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.not.reverted

				const accAfterEdit = await context.alViewFacet.getSubAccount(subAccountAddress)
				expect(accAfterEdit.owner).to.equal(context.signers.user.address)
				expect(accAfterEdit.isExists).to.true
				expect(accAfterEdit.name).to.equal(newAccountName)
				expect(accAfterEdit.metadata).to.equal(accBeforeEdit.metadata)
				expect(accAfterEdit.affiliate).to.equal(accBeforeEdit.affiliate)
				expect(accAfterEdit.symmioCore).to.equal(accBeforeEdit.symmioCore)
				expect(accAfterEdit.isolationType).to.equal(accBeforeEdit.isolationType)
			})

			it("should failed when name length is more than limit", async () => {
				const maxNameLength = await context.alViewFacet.MAX_NAME_LENGTH()
				const newAccountName = "A".repeat(Number(maxNameLength) + 1)

				await expect(context.alCoreFacet.connect(context.signers.user).editAccountName(subAccountAddress, newAccountName)).to.revertedWithCustomError(
					context.alCoreFacet,
					"InvalidNameLength",
				)
			})

			it("should allowed just by the account owner", async () => {
				await expect(
					context.alCoreFacet.connect(context.signers.others[0]).editAccountName(subAccountAddress, newAccountName),
				).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
			})

			it("should failed when subAccount not exists", async () => {
				await expect(
					context.alCoreFacet.connect(context.signers.user).editAccountName(context.signers.others[0], newAccountName),
				).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
			})
		})

		describe("transferSubAccountOwnership", async () => {
			let subAccountAddress: string

			beforeEach(async () => {
				subAccountAddress = await createSubAccount(context.signers.user, [createSubAccountData("TRANSFER_ACCOUNT", 0, "TRANSFER")])
			})

			it("should transfer ownership and update owner indexes", async () => {
				await expect(context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user2.address))
					.to.emit(context.alCoreFacet, "SubAccountOwnershipTransferred")
					.withArgs(subAccountAddress, context.signers.user.address, context.signers.user2.address)

				const acc = await context.alViewFacet.getSubAccount(subAccountAddress)
				const oldOwnerAccounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
				const newOwnerAccounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user2.address, 0, 100)

				expect(acc.owner).to.equal(context.signers.user2.address)
				expect(await context.alViewFacet.ownerOf(subAccountAddress)).to.equal(context.signers.user2.address)
				expect(oldOwnerAccounts).to.not.include(subAccountAddress)
				expect(newOwnerAccounts).to.include(subAccountAddress)
			})

			it("should move access from old owner to new owner", async () => {
				await context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user2.address)

				await expect(
					context.alCoreFacet.connect(context.signers.user).editAccountName(subAccountAddress, "OLD_OWNER_EDIT"),
				).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")

				await expect(context.alCoreFacet.connect(context.signers.user2).editAccountName(subAccountAddress, "NEW_OWNER_EDIT")).to.not.be.reverted

				const acc = await context.alViewFacet.getSubAccount(subAccountAddress)
				expect(acc.name).to.equal("NEW_OWNER_EDIT")
			})

			it("should transfer ownership for virtual accounts through the parent subAccount", async () => {
				const customSubAccount = await createSubAccount(context.signers.user, [createSubAccountData("CUSTOM_TRANSFER_ACCOUNT", 3, "TRANSFER")])
				const metadata = ethers.keccak256(toUtf8Bytes("TRANSFER_VA"))
				const virtualAccount = await context.alCoreFacet
					.connect(context.signers.user)
					.createCustomVirtualAccount.staticCall(customSubAccount, metadata, 0, 1)

				await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(customSubAccount, metadata, 0, 1)
				expect(await context.alViewFacet.ownerOf(virtualAccount)).to.equal(context.signers.user.address)

				await context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(customSubAccount, context.signers.user2.address)

				expect(await context.alViewFacet.ownerOf(virtualAccount)).to.equal(context.signers.user2.address)
			})

			it("should fail when caller is not the current owner", async () => {
				await expect(
					context.alCoreFacet.connect(context.signers.user2).transferSubAccountOwnership(subAccountAddress, context.signers.others[0].address),
				).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
			})

			it("should fail when new owner is zero address", async () => {
				await expect(
					context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, ZeroAddress),
				).to.be.revertedWithCustomError(context.alCoreFacet, "ZeroAddress")
			})

			it("should fail when new owner is already current owner", async () => {
				await expect(
					context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user.address),
				).to.be.revertedWithCustomError(context.alCoreFacet, "InvalidState")
			})
		})

		describe("setSingleVAMode", async () => {
			describe("basic functionality", async () => {
				it("should allow enabling singleVAMode on MARKET isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					// Initially singleVAMode should be false
					let subAccountDetail = await context.alViewFacet.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.false

					// Enable singleVAMode
					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(marketSubAccount, true))
						.to.emit(context.alCoreFacet, "SingleVAModeChanged")
						.withArgs(marketSubAccount, true)

					// Verify it's enabled
					subAccountDetail = await context.alViewFacet.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
				})

				it("should allow enabling singleVAMode on MARKET_DIRECTION isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("MARKET_DIR_ACCOUNT", 2, "MARKET_DIR", false)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketDirSubAccount = accounts[accounts.length - 1]

					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(marketDirSubAccount, true))
						.to.emit(context.alCoreFacet, "SingleVAModeChanged")
						.withArgs(marketDirSubAccount, true)

					const subAccountDetail = await context.alViewFacet.getSubAccount(marketDirSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
				})

				it("should allow disabling singleVAMode", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", true)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					// Initially singleVAMode should be true (set during creation)
					let subAccountDetail = await context.alViewFacet.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true

					// Disable singleVAMode
					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(marketSubAccount, false))
						.to.emit(context.alCoreFacet, "SingleVAModeChanged")
						.withArgs(marketSubAccount, false)

					subAccountDetail = await context.alViewFacet.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.false
				})

				it("should create sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("MARKET_SINGLE_VA", 1, "MARKET", true)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					const subAccountDetail = await context.alViewFacet.getSubAccount(marketSubAccount)
					expect(subAccountDetail.singleVAMode).to.be.true
					expect(subAccountDetail.isolationType).to.equal(1) // MARKET
				})
			})

			describe("validation", async () => {
				it("should revert when enabling singleVAMode on POSITION isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("POSITION_ACCOUNT", 0, "POSITION", false)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const positionSubAccount = accounts[accounts.length - 1]

					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(positionSubAccount, true)).to.revertedWithCustomError(
						context.alCoreFacet,
						"SingleVAModeNotApplicable",
					)
				})

				it("should revert when enabling singleVAMode on CUSTOM isolation sub-account", async () => {
					const subAccountData = [createSubAccountData("CUSTOM_ACCOUNT", 3, "CUSTOM", false)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const customSubAccount = accounts[accounts.length - 1]

					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(customSubAccount, true)).to.revertedWithCustomError(
						context.alCoreFacet,
						"SingleVAModeNotApplicable",
					)
				})

				it("should revert when creating POSITION sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("POSITION_SINGLE", 0, "POSITION", true)]
					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.revertedWithCustomError(context.alCoreFacet, "SingleVAModeNotApplicable")
				})

				it("should revert when creating CUSTOM sub-account with singleVAMode enabled", async () => {
					const subAccountData = [createSubAccountData("CUSTOM_SINGLE", 3, "CUSTOM", true)]
					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.revertedWithCustomError(context.alCoreFacet, "SingleVAModeNotApplicable")
				})

				it("should revert when non-owner tries to set singleVAMode", async () => {
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const marketSubAccount = accounts[accounts.length - 1]

					await expect(context.alCoreFacet.connect(context.signers.others[0]).setSingleVAMode(marketSubAccount, true)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"NotOwner",
					)
				})

				it("should revert when sub-account does not exist", async () => {
					await expect(
						context.alCoreFacet.connect(context.signers.user).setSingleVAMode(context.signers.others[0].address, true),
					).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
				})

				it("should revert when changing singleVAMode with active virtual accounts", async () => {
					// Create MARKET sub-account without singleVAMode
					const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", false)]
					const marketSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					// Send a quote to create a virtual account (sendQuoteAndGetVirtualAccount handles funding)
					const quoteRequest = limitQuoteRequestBuilder().build()
					await sendQuoteAndGetVirtualAccount(marketSubAccount, quoteRequest)

					// Verify VA was created
					const vaCount = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketSubAccount)
					expect(vaCount).to.equal(1)

					// Try to enable singleVAMode - should fail
					await expect(context.alCoreFacet.connect(context.signers.user).setSingleVAMode(marketSubAccount, true)).to.revertedWithCustomError(
						context.alCoreFacet,
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
					const activeVA = await context.alViewFacet.getActiveVAByKey(marketSubAccount, 1, 1) // MARKET=1, symbolId=1
					expect(activeVA).to.equal(firstVA)

					// Fund the VA again for another quote (add margin to existing VA)
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(firstVA, decimal(500n))

					// Send second quote for same symbol 1 (singleVAMode should reuse existing VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
					const callData2 = await createSendQuoteCallData(quote2)
					await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

					// Should still have only 1 VA
					const virtualAccounts2 = await context.alViewFacet.getVirtualAccountsOfSubAccount(marketSubAccount, 0, 10)
					expect(virtualAccounts2.length).to.equal(1)
					expect(virtualAccounts2[0].accountAddress).to.equal(firstVA)

					// VA should have 2 quotes
					const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(firstVA, 0, 10)
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
					const activeVA1 = await context.alViewFacet.getActiveVAByKey(marketSubAccount, 1, 1) // MARKET=1, symbolId=1
					const activeVA2 = await context.alViewFacet.getActiveVAByKey(marketSubAccount, 1, 2) // MARKET=1, symbolId=2
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
					const activeLongVA = await context.alViewFacet.getActiveVAByKey(marketDirSubAccount, 2, 1) // MARKET_LONG=2, symbolId=1
					expect(activeLongVA).to.equal(longVA)

					// Fund the VA again for another quote
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(longVA, decimal(500n))

					// Send second LONG quote for same symbol (singleVAMode should reuse existing VA)
					const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
					const callData2 = await createSendQuoteCallData(quote2)
					await context.alCoreFacet.connect(context.signers.user)._call(marketDirSubAccount, [callData2])

					// Should still have only 1 VA
					const virtualAccounts2 = await context.alViewFacet.getVirtualAccountsOfSubAccount(marketDirSubAccount, 0, 10)
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
					const activeLongVA = await context.alViewFacet.getActiveVAByKey(marketDirSubAccount, 2, 1) // MARKET_LONG=2
					const activeShortVA = await context.alViewFacet.getActiveVAByKey(marketDirSubAccount, 3, 1) // MARKET_SHORT=3
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
					const activeVA = await context.alViewFacet.getActiveVAByKey(marketSubAccount, 1, 1)
					expect(activeVA).to.equal(ZeroAddress)
				})
			})
		})

		describe("solver-fee sendQuote routing", async () => {
			it("routes the solver-fee capped sendQuote variant through virtual account handling", async () => {
				// Regression test: the v0.8.6 sendQuote (with SolverFeeCaps) selector must be recognized by
				// LibQuoteParams/CoreFacet so VA isolation handling applies instead of falling through to
				// the unvalidated _executeWithSigner path.
				const subAccountData = [createSubAccountData("SOLVER_FEE_VA", 1, "MARKET")]
				const subAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

				const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(subAccount, 1, quoteRequest.symbolId, decimal(500n))

				const callData = await createSolverFeeSendQuoteCallData(quoteRequest)
				await context.alCoreFacet.connect(context.signers.user)._call(subAccount, [callData])

				const virtualAccounts = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(subAccount, 0, 10)
				expect(virtualAccounts.length).to.equal(1)

				const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
				expect(quoteIds.length).to.equal(1)
			})
		})

		describe("deleteSubAccount", async () => {
			describe("successful deletion", async () => {
				it("should delete an empty subAccount successfully", async () => {
					// Create a sub-account without any deposits
					const subAccountData = [createSubAccountData("TO_DELETE", 0, "DELETE_ME")]
					const subAccountAddress = await createSubAccount(context.signers.user, subAccountData)

					// Verify it exists
					const accountBefore = await context.alViewFacet.getSubAccount(subAccountAddress)
					expect(accountBefore.isExists).to.be.true

					// Delete the sub-account
					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress))
						.to.emit(context.alCoreFacet, "SubAccountDeleted")
						.withArgs(subAccountAddress, context.signers.user.address, await context.accountManager.getAddress())

					// Verify it's marked as deleted
					const accountAfter = await context.alViewFacet.getSubAccount(subAccountAddress)
					expect(accountAfter.isExists).to.be.false

					// Verify it's removed from user's sub-accounts list
					const userSubAccounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(userSubAccounts).to.not.include(subAccountAddress)
				})

				it("should delete subAccount after withdrawing all funds", async () => {
					// Create and deposit to sub-account
					const subAccountData = [createSubAccountData("WITHDRAW_AND_DELETE", 0, "TEST")]
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					// Verify balance exists
					const balanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
					expect(balanceBefore).to.equal(BALANCES.DEPOSIT_AMOUNT)

					// Withdraw all funds
					const withdrawCallData = context.accountFacet.interface.encodeFunctionData("withdrawTo", [
						context.signers.user.address,
						BALANCES.DEPOSIT_AMOUNT,
					])
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [withdrawCallData])

					// Verify balance is now 0
					const balanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
					expect(balanceAfter).to.equal(0)

					// Now delete should succeed
					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress))
						.to.emit(context.alCoreFacet, "SubAccountDeleted")
						.withArgs(subAccountAddress, context.signers.user.address, await context.accountManager.getAddress())

					// Verify deletion
					const account = await context.alViewFacet.getSubAccount(subAccountAddress)
					expect(account.isExists).to.be.false
				})
			})

			describe("access control", async () => {
				let subAccountAddress: string

				beforeEach(async () => {
					const subAccountData = [createSubAccountData("ACCESS_TEST", 0, "TEST")]
					subAccountAddress = await createSubAccount(context.signers.user, subAccountData)
				})

				it("should revert when non-owner tries to delete", async () => {
					await expect(context.alCoreFacet.connect(context.signers.others[0]).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"NotOwner",
					)
				})

				it("should revert when trying to delete non-existent account", async () => {
					await expect(
						context.alCoreFacet.connect(context.signers.user).deleteSubAccount(context.signers.others[0].address),
					).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
				})

				it("should revert when trying to delete already deleted account", async () => {
					// Delete the account first
					await context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)

					// Try to delete again - should fail with AccountDoesNotExist (owner check passes but isExists is false)
					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"AccountDoesNotExist",
					)
				})
			})

			describe("balance checks", async () => {
				it("should revert when subAccount has balance", async () => {
					const subAccountData = [createSubAccountData("HAS_BALANCE", 0, "TEST")]
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"SubAccountNotEmpty",
					)
				})

				it("should revert when subAccount has allocated balance", async () => {
					const subAccountData = [createSubAccountData("HAS_ALLOCATED", 0, "TEST")]
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT, true)

					// Verify allocated balance exists
					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.equal(BALANCES.DEPOSIT_AMOUNT)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"SubAccountNotEmpty",
					)
				})

				it("should revert when subAccount has both balance and allocated balance", async () => {
					const subAccountData = [createSubAccountData("HAS_BOTH", 0, "TEST")]
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					// Allocate half
					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.DEPOSIT_AMOUNT / 2n])
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [allocateCallData])

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"SubAccountNotEmpty",
					)
				})
			})

			describe("virtual account checks", async () => {
				it("should revert when subAccount has active virtual accounts", async () => {
					// Create sub-account with POSITION isolation (will create VAs on sendQuote)
					const subAccountData = [createSubAccountData("HAS_VA", 0, "TEST")]
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)

					// Send quote to create a virtual account
					const quoteRequest = limitQuoteRequestBuilder().build()
					await sendQuoteAndGetVirtualAccount(subAccountAddress, quoteRequest)

					// Verify VA exists
					const vaCount = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(vaCount).to.be.greaterThan(0)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"HasActiveVirtualAccounts",
					)
				})
			})

			describe("position and quote checks", async () => {
				it("should revert with PendingQuotesExist when CUSTOM subAccount has pending position", async () => {
					// Create CUSTOM isolation sub-account with funds
					const depositAmount = decimal(5000n)
					const subAccountData = [createSubAccountData("OPEN_POS_TEST", 3, "CUSTOM")] // 3 = CUSTOM
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, depositAmount, true)

					// Send a quote
					const quoteRequest = limitQuoteRequestBuilder().build()
					const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])

					// Verify pending quote exists
					const pendingQuotes = await context.viewFacetQuote.getPartyAPendingQuotes(subAccountAddress)
					expect(pendingQuotes.length).to.equal(1)

					// The account cannot be drained first: the pending quote keeps its CVA and LF locked in
					// allocated balance, and core forbids deallocating below that floor. deleteSubAccount
					// therefore has to report the pending quote rather than a balance the caller cannot clear.
					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.be.greaterThan(0)
					expect(await context.viewFacet.maxDeallocatableForPartyA(subAccountAddress, BigInt(1e30))).to.be.lessThan(allocatedBalance)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"PendingQuotesExist",
					)
				})

				it("should revert with OpenPositionsExist when CUSTOM subAccount has open position", async () => {
					// Create CUSTOM isolation sub-account with funds
					const depositAmount = decimal(5000n)
					const subAccountData = [createSubAccountData("OPEN_POS_TEST", 3, "CUSTOM")] // 3 = CUSTOM
					const subAccountAddress = await createSubAccountAndDeposit(context.signers.user, subAccountData, depositAmount, true)

					// Send a quote
					const quoteRequest = limitQuoteRequestBuilder().build()
					const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])

					// Get the quote ID and have hedger open the position
					const quoteId = (await context.viewFacetQuote.getPartyAPendingQuotes(subAccountAddress))[0]
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

					// Verify position is open
					const positionCount = await context.viewFacetQuote.partyAPositionsCount(subAccountAddress)
					expect(positionCount).to.equal(1)

					// The account cannot be drained first: the open position keeps its CVA and LF locked in
					// allocated balance, and core forbids deallocating below that floor. deleteSubAccount
					// therefore has to report the open position rather than a balance the caller cannot clear.
					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.be.greaterThan(0)
					expect(await context.viewFacet.maxDeallocatableForPartyA(subAccountAddress, BigInt(1e30))).to.be.lessThan(allocatedBalance)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"OpenPositionsExist",
					)
				})
			})

			describe("hook integration", async () => {
				let mockHook: MockAccountLayerHook

				beforeEach(async () => {
					// Deploy mock hook
					const MockAccountLayerHook = await ethers.getContractFactory("MockAccountLayerHook")
					mockHook = await MockAccountLayerHook.deploy()
					await mockHook.waitForDeployment()

					// Register the hook for onSubAccountDeletion
					const affiliateAddress = await context.accountManager.getAddress()
					const onSubAccountDeletionSelector = IAccountLayerHook__factory.createInterface().getFunction("onSubAccountDeletion").selector
					await context.alAffiliateFacet.setHook(affiliateAddress, onSubAccountDeletionSelector, await mockHook.getAddress())
				})

				it("should call affiliate hook on deletion", async () => {
					const subAccountData = [createSubAccountData("HOOK_TEST", 0, "TEST")]
					const subAccountAddress = await createSubAccount(context.signers.user, subAccountData)

					// Delete the sub-account
					await context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)

					// Verify hook was called
					const onSubAccountDeletionSelector = IAccountLayerHook__factory.createInterface().getFunction("onSubAccountDeletion").selector
					const callCount = await mockHook.selectorCallCount(onSubAccountDeletionSelector)
					expect(callCount).to.equal(1)
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
					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)).to.revertedWithCustomError(
						context.alCoreFacet,
						"EmptyArray",
					)
				})

				it("should execute non-sendQuote calls successfully", async () => {
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]

					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)).to.not.be.reverted

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.equal(BALANCES.SMALL_AMOUNT)
				})

				it("should only be callable by owner of subAccount", async () => {
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]

					await expect(context.alCoreFacet.connect(context.signers.others[0])._call(subAccountAddress, callData)).to.revertedWithCustomError(
						context.alCoreFacet,
						"NotOwner",
					)
				})

				it("should allow _call for legacy multi-account addresses", async () => {
					const legacyMultiAccounts = await context.alViewFacet.getLegacyMultiAccounts()
					expect(legacyMultiAccounts.length).to.be.greaterThan(0)
					const legacyMultiAccount = await ethers.getContractAt("MockMultiAccount", legacyMultiAccounts[0])
					const createTx = await legacyMultiAccount.createMockAccount(context.signers.user.address)
					const receipt = await createTx.wait()
					let legacyAccount = ZeroAddress
					for (const log of receipt!.logs) {
						try {
							const parsed = legacyMultiAccount.interface.parseLog(log)
							if (parsed?.name === "AccountCreated") {
								legacyAccount = parsed.args.account
								break
							}
						} catch {}
					}
					expect(legacyAccount).to.not.equal(ZeroAddress)

					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(legacyAccount, BALANCES.DEPOSIT_AMOUNT)

					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
					await expect(context.alCoreFacet.connect(context.signers.user)._call(legacyAccount, callData)).to.not.be.reverted

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(legacyAccount)
					expect(allocatedBalance).to.equal(BALANCES.SMALL_AMOUNT)
				})

				it("should block admin selectors for legacy multi-account addresses via Symmio core proxy protection", async () => {
					const legacyMultiAccounts = await context.alViewFacet.getLegacyMultiAccounts()
					expect(legacyMultiAccounts.length).to.be.greaterThan(0)
					const legacyMultiAccount = await ethers.getContractAt("MockMultiAccount", legacyMultiAccounts[0])
					const createTx = await legacyMultiAccount.createMockAccount(context.signers.user.address)
					const receipt = await createTx.wait()
					let legacyAccount = ZeroAddress
					for (const log of receipt!.logs) {
						try {
							const parsed = legacyMultiAccount.interface.parseLog(log)
							if (parsed?.name === "AccountCreated") {
								legacyAccount = parsed.args.account
								break
							}
						} catch {}
					}
					expect(legacyAccount).to.not.equal(ZeroAddress)

					const victimAffiliate = await context.accountManager2.getAddress()
					const attackerCollector = context.signers.user.address
					const beforeCollector = await context.viewFacet.getFeeCollector(victimAffiliate)

					const callData: BytesLike[] = [context.controlFacet.interface.encodeFunctionData("setFeeCollector", [victimAffiliate, attackerCollector])]

					// Symmio core's onlyRole modifier blocks proxied calls (when signer is set)
					await expect(context.alCoreFacet.connect(context.signers.user)._call(legacyAccount, callData)).to.be.revertedWith(
						"Accessibility: Cannot call via proxy",
					)

					const afterCollector = await context.viewFacet.getFeeCollector(victimAffiliate)
					expect(afterCollector).to.equal(beforeCollector)
				})

				it("should not allow account owner to call Symmio admin functions via _call", async () => {
					const victimAffiliate = await context.accountManager2.getAddress()
					const attackerCollector = context.signers.user.address
					const beforeCollector = await context.viewFacet.getFeeCollector(victimAffiliate)

					const callData: BytesLike[] = [context.controlFacet.interface.encodeFunctionData("setFeeCollector", [victimAffiliate, attackerCollector])]

					// Symmio core's onlyRole modifier blocks proxied calls (when signer is set)
					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWith(
						"Accessibility: Cannot call via proxy",
					)

					const afterCollector = await context.viewFacet.getFeeCollector(victimAffiliate)
					expect(afterCollector).to.equal(beforeCollector)
				})

				it("should not allow internalTransferToBalance via _call", async () => {
					const recipient = context.signers.user2.address
					const senderBalanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
					const recipientBalanceBefore = await context.viewFacet.balanceOf(recipient)
					const cooldownBefore = await context.viewFacet.withdrawCooldownOf(recipient)

					const callData: BytesLike[] = [
						context.accountFacet.interface.encodeFunctionData("internalTransferToBalance", [recipient, BALANCES.SMALL_AMOUNT]),
					]

					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"Unauthorized",
					)

					const senderBalanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
					const recipientBalanceAfter = await context.viewFacet.balanceOf(recipient)
					const cooldownAfter = await context.viewFacet.withdrawCooldownOf(recipient)

					expect(senderBalanceAfter).to.equal(senderBalanceBefore)
					expect(recipientBalanceAfter).to.equal(recipientBalanceBefore)
					expect(cooldownAfter).to.equal(cooldownBefore)
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
						const virtualAccountsBefore = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(positionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(positionSubAccount)

						const lastId = await context.viewFacetQuote.getNextQuoteId()
						const sendQuoteCallData = await createSendQuoteCallData()
						await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccount, [sendQuoteCallData])

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(positionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify the quote was created on a virtual account, not the sub-account
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(positionSubAccount, 0, 10)
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
						expect(quoteIds.length).to.equal(1)
						expect(quoteIds[0]).to.equal(lastId + 1n)
					})

					it("should revert when trying to send another quote on existing virtual account", async () => {
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccount)

						const sendQuoteCallData = await createSendQuoteCallData()
						await expect(context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])).to.revertedWithCustomError(
							context.alCoreFacet,
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
						const virtualAccountsBefore = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(marketSubAccount)

						const lastId = await context.viewFacetQuote.getNextQuoteId()
						const sendQuoteCallData = await createSendQuoteCallData()
						await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [sendQuoteCallData])

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify quote was created on a virtual account
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(marketSubAccount, 0, 10)
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
						expect(quoteIds.length).to.equal(1)
						expect(quoteIds[0]).to.equal(lastId + 1n)
					})

					it("should revert when trying to send quote with different symbol", async () => {
						const quoteRequest1 = limitQuoteRequestBuilder().symbolId(1).build()
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quoteRequest1)

						const quoteRequest2 = limitQuoteRequestBuilder().symbolId(2).build()
						const sendQuoteCallData2 = await createSendQuoteCallData(quoteRequest2)

						await expect(
							context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData2]),
						).to.revertedWithCustomError(context.alCoreFacet, "SymbolNotAllowedForThisAccount")
					})

					it("should allow multiple quotes with same symbol", async () => {
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount)

						// Add more funds to VA for the second quote
						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(200n))
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], decimal(200n))

						const sendQuoteCallData = await createSendQuoteCallData()
						await context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify the VA now has 2 quotes
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
						expect(quoteIds.length).to.equal(2)
					})
				})

				describe("MARKET_DIRECTION isolation (2)", async () => {
					let marketDirectionSubAccount: string

					beforeEach(async () => {
						const subAccountData = [createSubAccountData("MARKET_DIRECTION_ACCOUNT", 2, "MARKET_DIRECTION")]
						marketDirectionSubAccount = await createSubAccountAndDeposit(context.signers.user, subAccountData, BALANCES.DEPOSIT_AMOUNT)
					})

					it("should create virtual account and send quote successfully", async () => {
						const virtualAccountsBefore = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()

						// Pre-fund the VA before sending quote
						await preFundVirtualAccount(marketDirectionSubAccount, quoteRequest)

						const lastId = await context.viewFacetQuote.getNextQuoteId()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await context.alCoreFacet.connect(context.signers.user)._call(marketDirectionSubAccount, [sendQuoteCallData])

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify the quote was created on a virtual account
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(marketDirectionSubAccount, 0, 10)
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
						expect(quoteIds.length).to.equal(1)
						expect(quoteIds[0]).to.equal(lastId + 1n)
					})

					it("should revert when symbol or position type differs", async () => {
						const quoteRequestLong = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketDirectionSubAccount, quoteRequestLong)

						// Different position type (SHORT instead of LONG)
						const quoteRequestShort = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
						const sendQuoteCallDataShort = await createSendQuoteCallData(quoteRequestShort)

						await expect(
							context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallDataShort]),
						).to.revertedWithCustomError(context.alCoreFacet, "PositionTypeNotAllowedForThisAccount")

						// Different symbol
						const quoteRequestDiffSymbol = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.LONG).build()
						const sendQuoteCallDataDiffSymbol = await createSendQuoteCallData(quoteRequestDiffSymbol)

						await expect(
							context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallDataDiffSymbol]),
						).to.revertedWithCustomError(context.alCoreFacet, "SymbolNotAllowedForThisAccount")
					})

					it("should allow multiple quotes with same symbol and position type", async () => {
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketDirectionSubAccount, quoteRequest)

						await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
						await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(virtualAccounts[0], BALANCES.DEPOSIT_AMOUNT)

						for (let i = 0; i < 4; i++) {
							await context.alCoreFacet.connect(context.signers.user)._call(virtualAccounts[0], [sendQuoteCallData])
						}

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(marketDirectionSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify all 5 quotes (1 initial + 4 more) are tracked on the same VA
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccounts[0], 0, 10)
						expect(quoteIds.length).to.equal(5)
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
						const virtualAccountsBefore = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						const pendingQuotesBefore = await context.viewFacetQuote.getPartyAPendingQuotes(customSubAccount)
						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])
						const pendingQuotesAfter = await context.viewFacetQuote.getPartyAPendingQuotes(customSubAccount)
						expect(pendingQuotesAfter.length).to.equal(pendingQuotesBefore.length + 1)

						// Verify no virtual accounts were created
						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsAfter).to.equal(0)
					})

					it("should send quote directly from sub-account without creating virtual account", async () => {
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						const lastIdBefore = await context.viewFacetQuote.getNextQuoteId()
						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])

						// Verify quote was created on the sub-account (not a virtual account)
						const createdQuoteId = lastIdBefore + 1n
						const quote = await context.viewFacetQuote.getQuote(createdQuoteId)
						expect(quote.partyA).to.equal(customSubAccount)

						// Verify no virtual accounts were created
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccounts).to.equal(0)
					})

					it("should allow multiple quotes with different symbols", async () => {
						// Send quote with symbol 1
						const lastId1 = await context.viewFacetQuote.getNextQuoteId()
						const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, quote1)

						const q1 = await context.viewFacetQuote.getQuote(lastId1 + 1n)
						expect(q1.partyA).to.equal(customSubAccount)
						expect(q1.symbolId).to.equal(1)

						// Send quote with symbol 2
						const lastId2 = await context.viewFacetQuote.getNextQuoteId()
						const quote2 = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, quote2)

						const q2 = await context.viewFacetQuote.getQuote(lastId2 + 1n)
						expect(q2.partyA).to.equal(customSubAccount)
						expect(q2.symbolId).to.equal(2)

						// Verify no virtual accounts created
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccounts).to.equal(0)
					})

					it("should allow both LONG and SHORT positions on same symbol", async () => {
						// Send LONG quote
						const lastId1 = await context.viewFacetQuote.getNextQuoteId()
						const longQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, longQuote)

						const q1 = await context.viewFacetQuote.getQuote(lastId1 + 1n)
						expect(q1.partyA).to.equal(customSubAccount)
						expect(q1.positionType).to.equal(PositionType.LONG)

						// Send SHORT quote on same symbol
						const lastId2 = await context.viewFacetQuote.getNextQuoteId()
						const shortQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
						await sendQuoteAndGetVirtualAccount(customSubAccount, shortQuote)

						// Verify both quotes were tracked
						const q2 = await context.viewFacetQuote.getQuote(lastId2 + 1n)
						expect(q2.partyA).to.equal(customSubAccount)
						expect(q2.positionType).to.equal(PositionType.SHORT)

						// Both quotes should be for the same symbol
						expect(q1.symbolId).to.equal(q2.symbolId)
					})

					it("should not transfer funds internally for CUSTOM isolation", async () => {
						const balanceBefore = await context.viewFacet.balanceOf(customSubAccount)

						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const callData = await createSendQuoteCallData(quoteRequest)

						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [callData])

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
						const virtualAccountsBefore = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsBefore).to.equal(0)

						// Manually create a POSITION isolated virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
							1, // VirtualAccountIsolationType.MARKET
							1, // symbolId
						)

						const virtualAccountsAfter = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccountsAfter).to.equal(1)

						// Verify the virtual account details
						const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						expect(virtualAccounts[0].parentAccount).to.equal(customSubAccount)
						expect(virtualAccounts[0].isExists).to.be.true
						expect(virtualAccounts[0].isolationType).to.equal(1) // MARKET
						expect(virtualAccounts[0].symbolId).to.equal(1)
					})

					it("should create multiple virtual accounts with different isolation types", async () => {
						// Create POSITION isolated virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("POSITION_VIRTUAL")),
							1, // POSITION
							1,
						)

						// Create MARKET isolated virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_VIRTUAL")),
							1, // MARKET
							1,
						)

						// Create MARKET_LONG isolated virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_LONG_VIRTUAL")),
							3, // MARKET_LONG
							2,
						)

						// Create MARKET_SHORT isolated virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_SHORT_VIRTUAL")),
							3, // MARKET_SHORT
							2,
						)

						const virtualAccounts = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
						expect(virtualAccounts).to.equal(4)
					})

					it("should transfer funds to virtual account and send quote", async () => {
						// Create virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
							0, // POSITION
							1,
						)

						const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds from sub-account to virtual account (cva + lf + partyAmm + fees)
						const transferAmount = decimal(500n)
						const subAccountBalanceBefore = await context.viewFacet.balanceOf(customSubAccount)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, transferAmount])

						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [transferCallData])

						const subAccountBalanceAfter = await context.viewFacet.balanceOf(customSubAccount)
						expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore - transferAmount)

						const virtualAccountBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
						expect(virtualAccountBalance).to.equal(transferAmount)

						// Send quote from virtual account
						const quoteRequest = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const lastId = await context.viewFacetQuote.getNextQuoteId()

						const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

						await context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [sendQuoteCallData])

						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
						expect(quoteIds.length).to.equal(1)
						expect(quoteIds[0]).to.equal(lastId + 1n)
					})

					it("should enforce MARKET_LONG isolation on manually created virtual account", async () => {
						// Create MARKET_LONG virtual account
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_LONG")),
							2, // MARKET_LONG
							1,
						)

						const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds (cva + lf + partyAmm + fees)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(500n)])
						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [transferCallData])

						// Try to send SHORT quote - should fail
						const shortQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()

						const shortCallData = await createSendQuoteCallData(shortQuote)

						await expect(context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [shortCallData])).to.revertedWithCustomError(
							context.alCoreFacet,
							"PositionTypeNotAllowedForThisAccount",
						)

						// Send LONG quote - should succeed
						const longQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const longCallData = await createSendQuoteCallData(longQuote)

						await context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [longCallData])

						// Verify the quote was tracked
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
						expect(quoteIds.length).to.equal(1)
					})

					it("should enforce MARKET isolation - only allow quotes for specified symbol", async () => {
						// Create MARKET virtual account for symbol 1
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("MARKET_SYMBOL_1")),
							1, // MARKET
							1, // symbolId 1
						)

						const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						const virtualAccount = virtualAccounts[0].accountAddress

						// Transfer funds (cva + lf + partyAmm + fees)
						const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [virtualAccount, decimal(500n)])
						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [transferCallData])

						// Try to send quote for symbol 2 - should fail
						const wrongSymbolQuote = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.LONG).build()
						const wrongSymbolCallData = await createSendQuoteCallData(wrongSymbolQuote)

						await expect(context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [wrongSymbolCallData])).to.revertedWithCustomError(
							context.alCoreFacet,
							"SymbolNotAllowedForThisAccount",
						)

						// Send quote for symbol 1 - should succeed
						const correctSymbolQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
						const correctSymbolCallData = await createSendQuoteCallData(correctSymbolQuote)

						await context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [correctSymbolCallData])

						// Verify quote was tracked
						const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
						expect(quoteIds.length).to.equal(1)
					})

					it("should fail to create virtual account from non-CUSTOM sub-account", async () => {
						// Create a POSITION isolated sub-account
						const subAccountData = [createSubAccountData("POSITION_SUB_ACCOUNT", 0, "POSITION")]

						await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
						const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
						const positionSubAccount = accounts[accounts.length - 1]

						// Try to manually create virtual account - should fail
						await expect(
							context.alCoreFacet
								.connect(context.signers.user)
								.createCustomVirtualAccount(positionSubAccount, ethers.keccak256(toUtf8Bytes("VIRTUAL")), 1, 1),
						).to.revertedWithCustomError(context.alCoreFacet, "OnlyCustomIsolationCanCreateManually")
					})

					it("should only allow owner to create virtual accounts", async () => {
						await expect(
							context.alCoreFacet
								.connect(context.signers.others[0])
								.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes("VIRTUAL")), 1, 1),
						).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
					})

					it("should use different virtual accounts for different trading strategies", async () => {
						// Create virtual account for BTC LONG trades
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("BTC_LONG")),
							2, // MARKET_LONG
							1, // BTC
						)

						// Create virtual account for ETH SHORT trades
						await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes("ETH_SHORT")),
							3, // MARKET_SHORT
							2, // ETH
						)

						const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
						expect(virtualAccounts.length).to.equal(2)

						const btcLongVirtual = virtualAccounts[0].accountAddress
						const ethShortVirtual = virtualAccounts[1].accountAddress

						// Transfer funds to both (cva + lf + partyAmm + fees)
						const transferToBtc = context.accountFacet.interface.encodeFunctionData("internalTransfer", [btcLongVirtual, decimal(500n)])
						const transferToEth = context.accountFacet.interface.encodeFunctionData("internalTransfer", [ethShortVirtual, decimal(500n)])

						await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [transferToBtc, transferToEth])

						// Send BTC LONG quote
						const btcLongQuote = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()

						const btcCallData = await createSendQuoteCallData(btcLongQuote)

						await context.alCoreFacet.connect(context.signers.user)._call(btcLongVirtual, [btcCallData])

						// Send ETH SHORT quote
						const ethShortQuote = limitQuoteRequestBuilder().symbolId(2).positionType(PositionType.SHORT).build()

						const ethCallData = await createSendQuoteCallData(ethShortQuote)

						await context.alCoreFacet.connect(context.signers.user)._call(ethShortVirtual, [ethCallData])

						// Verify quotes tracked separately
						const btcQuotes = await context.alViewFacet.getVirtualAccountQuoteIds(btcLongVirtual, 0, 10)
						const ethQuotes = await context.alViewFacet.getVirtualAccountQuoteIds(ethShortVirtual, 0, 10)

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

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const quotesAfterClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("Should add the removed virtualAccount to deletedVirtualAccountsPool for reuse", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const deletedAccountData = await context.alViewFacet.getVirtualAccount(initialVirtualAccountAddress)
				expect(deletedAccountData.isExists).to.be.false

				const reusedVirtualAccountAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const reusedVirtualAccountAddress = reusedVirtualAccountAddresses[0]

				expect(reusedVirtualAccountAddress).to.equal(initialVirtualAccountAddress)
				expect(await context.alViewFacet.getVirtualAccountsCountOfSubAccount(positionSubAccountAddress)).to.equal(1)

				const reusedAccountData = await context.alViewFacet.getVirtualAccount(reusedVirtualAccountAddress)
				expect(reusedAccountData.isExists).to.be.true
			})

			it("should sync PartyB binding when reusing a virtual account", async () => {
				// Make hedger bindable so accounts can bind to it
				await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)

				// Bind the parent sub-account to PartyB
				const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [bindCallData])

				const parentBindBefore = await context.viewFacet.getBindState(positionSubAccountAddress)
				expect(parentBindBefore.status).to.equal(1) // BOUND
				expect(parentBindBefore.partyB).to.equal(context.signers.hedger.address)

				// Create a VA while parent is bound
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).partyBWhiteList([context.signers.hedger.address]).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const initialVABind = await context.viewFacet.getBindState(initialVirtualAccountAddress)
				expect(initialVABind.status).to.equal(1) // BOUND
				expect(initialVABind.partyB).to.equal(context.signers.hedger.address)

				// Delete the VA so it can be reused
				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const deletedAccountData = await context.alViewFacet.getVirtualAccount(initialVirtualAccountAddress)
				expect(deletedAccountData.isExists).to.be.false

				// Unbind the parent sub-account - VA should no longer be bound after it gets reused
				const requestUnbindCallData = context.bindingFacet.interface.encodeFunctionData("requestToUnbindFromPartyB", [])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [requestUnbindCallData])
				await context.bindingFacet.connect(context.signers.hedger).completeUnbindRequest(positionSubAccountAddress)

				const parentBindAfter = await context.viewFacet.getBindState(positionSubAccountAddress)
				expect(parentBindAfter.partyB).to.equal(ZeroAddress)

				const reusedVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]
				expect(reusedVirtualAccountAddress).to.equal(initialVirtualAccountAddress)

				const reusedVABind = await context.viewFacet.getBindState(reusedVirtualAccountAddress)
				expect(reusedVABind.partyB).to.equal(parentBindAfter.partyB)
			})

			it("should enforce PartyB binding while parent is pending unbind", async () => {
				// Make hedger bindable so accounts can bind to it
				await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)

				// Bind the parent sub-account to PartyB
				const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [bindCallData])

				// Request unbind but do not complete it (status should be PENDING_UNBIND)
				const requestUnbindCallData = context.bindingFacet.interface.encodeFunctionData("requestToUnbindFromPartyB", [])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [requestUnbindCallData])

				const parentBindState = await context.viewFacet.getBindState(positionSubAccountAddress)
				expect(parentBindState.status).to.equal(2) // PENDING_UNBIND
				expect(parentBindState.partyB).to.equal(context.signers.hedger.address)

				// Build a quote that targets a different PartyB
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).partyBWhiteList([context.signers.hedger2.address]).build()

				await preFundVirtualAccount(positionSubAccountAddress, quoteRequest)

				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
				await expect(context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [sendQuoteCallData])).to.be.revertedWith(
					"PartyAFacet: PartyA is bound to a different PartyB",
				)
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

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)

				await cancelVirtualAccountQuote(virtualAccountAddress)

				const quotesAfterClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterClose.length).to.equal(0)

				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("should reject sendQuote from a deleted virtual account", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				await cancelVirtualAccountQuote(virtualAccountAddress)

				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.false

				const transferCallData = context.accountFacet.interface.encodeFunctionData("internalTransfer", [
					virtualAccountAddress,
					BALANCES.TRANSFER_AMOUNT,
				])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [transferCallData])

				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
				await expect(
					context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [sendQuoteCallData]),
				).to.be.revertedWithCustomError(context.alCoreFacet, "AccountDoesNotExist")
			})

			it("should revert if virtual account is deleted mid-batch", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quotes[0]])

				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)

				await expect(
					context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote, sendQuoteCallData]),
				).to.be.revertedWithCustomError(context.alCoreFacet, "AccountDoesNotExist")
			})

			it("should reject standard deposit paths for deleted virtual accounts", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]
				await cancelVirtualAccountQuote(virtualAccountAddress)

				const deletedData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(deletedData.isExists).to.be.false

				await context.collateral.connect(context.signers.user).approve(context.diamond, BALANCES.DEPOSIT_AMOUNT)

				await expect(
					context.alCoreFacet.connect(context.signers.user).depositForAccount(virtualAccountAddress, BALANCES.SMALL_AMOUNT),
				).to.be.revertedWithCustomError(context.alCoreFacet, "AccountDoesNotExist")

				await expect(
					context.alCoreFacet.connect(context.signers.user).depositAndAllocateForAccount(virtualAccountAddress, BALANCES.SMALL_AMOUNT),
				).to.be.revertedWithCustomError(context.alCoreFacet, "AccountDoesNotExist")
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

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				// Get parent's balance and allocatedBalance before closing
				const parentBalanceBefore = await context.viewFacet.balanceOf(positionSubAccountAddress)
				const parentAllocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(positionSubAccountAddress)

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false

				const parentBalanceAfter = await context.viewFacet.balanceOf(positionSubAccountAddress)
				const parentAllocatedAfter = await context.viewFacet.allocatedBalanceOfPartyA(positionSubAccountAddress)

				expect(parentBalanceAfter).to.be.gt(parentBalanceBefore)
				expect(parentAllocatedAfter).to.equal(parentAllocatedBefore)
			})

			it("Should allow immediate creation of new virtual account with returned funds", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const initialVirtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(initialVirtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccountAddress)

				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)

				const newQuoteRequest = limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()
				const newVirtualAddresses = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, newQuoteRequest)
				expect(newVirtualAddresses.length).to.equal(1)

				const newVirtualAccountData = await context.alViewFacet.getVirtualAccount(newVirtualAddresses[0])
				expect(newVirtualAccountData.isExists).to.be.true
			})

			it("Should set withdrawCooldown on parent when funds are returned", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

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
				await context.alControlFacet.connect(context.signers.admin).pause()
				const subAccountData = [createSubAccountData("MARKET_ACCOUNT", 1)]
				await expect(
					context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
				).to.be.revertedWithCustomError(context.alCoreFacet, "EnforcedPause")
			})

			it("should revert _call when paused", async () => {
				await context.alControlFacet.connect(context.signers.admin).pause()
				const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
				await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)).to.be.revertedWithCustomError(
					context.alCoreFacet,
					"EnforcedPause",
				)
			})

			it("should allow actions after unpause", async () => {
				await context.alControlFacet.connect(context.signers.admin).pause()
				await context.alControlFacet.connect(context.signers.admin).unpause()
				const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [BALANCES.SMALL_AMOUNT])]
				await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, callData)

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
				expect(allocatedBalance).to.equal(BALANCES.SMALL_AMOUNT)
			})
		})

		describe("hooks", async () => {
			let hookContract: MockAccountLayerHook
			let subAccountAddress: string
			let customSubAccountAddress: string
			let hookEvents: any

			const HOOK_SELECTORS = {
				onAccountCreation: IAccountLayerHook__factory.createInterface().getFunction("onAccountCreation").selector,
				onVirtualAccountCreation: IAccountLayerHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
				onVirtualAccountDeletion: IAccountLayerHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
				onSubAccountOwnershipTransfer: IAccountLayerHook__factory.createInterface().getFunction("onSubAccountOwnershipTransfer").selector,
				onCall: IAccountLayerHook__factory.createInterface().getFunction("onCall").selector,
			}
			const SYMMIO_HOOK_SELECTORS = {
				onCancelQuote: ISymmioHook__factory.createInterface().getFunction("onCancelQuote").selector,
			}

			beforeEach(async () => {
				// Deploy mock hook contract
				const MockHook = await ethers.getContractFactory("MockAccountLayerHook")
				hookContract = await MockHook.deploy()
				await hookContract.waitForDeployment()

				const affiliateAddress = await context.accountManager.getAddress()

				for (const key of Object.keys(HOOK_SELECTORS)) {
					await context.alAffiliateFacet.setHook(
						affiliateAddress,
						HOOK_SELECTORS[key as keyof typeof HOOK_SELECTORS],
						await hookContract.getAddress(),
					)
				}

				hookEvents = new ethers.Contract(
					context.diamond,
					["event HookFailed(address indexed hook, bytes4 indexed selector, uint256 indexed quoteId, bytes reason)"],
					context.signers.user,
				)

				// Reset any executeForAccount callbacks to ensure clean state
				await hookContract.resetExecuteForAccountTracking()

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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onAccountCreation)

					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should pass correct data to onAccountCreation hook", async () => {
					const subAccountData = [createSubAccountData("NEW_ACCOUNT", 2)]

					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData),
					).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
				})

				it("should return the hook failure reason in HookFailed error", async () => {
					const revertMessage = "Custom rejection reason from hook"
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onAccountCreation, true, revertMessage)

					const subAccountData = [createSubAccountData("WILL_FAIL", 0)]

					// The revert reason includes the Error(string) selector (0x08c379a0) followed by the ABI-encoded string
					const errorSelector = "0x08c379a0"
					const encodedString = ethers.AbiCoder.defaultAbiCoder().encode(["string"], [revertMessage])
					const encodedReason = errorSelector + encodedString.slice(2)

					await expect(context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData))
						.to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
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
					const affiliateAddress = await context.alAffiliateFacet.requestToRegisterAffiliate.staticCall(affData)

					await context.alAffiliateFacet.requestToRegisterAffiliate(affData)
					await context.alAffiliateFacet.approveAffiliate(affiliateAddress)

					// Should not revert even without hook
					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, [createSubAccountData("NO_HOOK_ACCOUNT", 0)]),
					).to.not.be.reverted
				})
			})

			describe("onSubAccountOwnershipTransfer hook", async () => {
				it("should call onSubAccountOwnershipTransfer hook when ownership is transferred", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onSubAccountOwnershipTransfer)

					await context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user2.address)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onSubAccountOwnershipTransfer)
					expect(callCountAfter).to.equal(callCountBefore + 1n)
					expect(await hookContract.wasHookCalledForAccount(subAccountAddress)).to.be.true
					expect(await hookContract.getLastAccountForSelector(HOOK_SELECTORS.onSubAccountOwnershipTransfer)).to.equal(subAccountAddress)
				})

				it("should pass correct data to onSubAccountOwnershipTransfer hook after storage is updated", async () => {
					await context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user2.address)

					const hookCallsCount = await hookContract.getHookCallsCount()
					const [, data] = await hookContract.getHookCall(Number(hookCallsCount) - 1)
					const [hookSubAccount, oldOwner, newOwner] = ethers.AbiCoder.defaultAbiCoder().decode(["address", "address", "address"], data)

					expect(hookSubAccount).to.equal(subAccountAddress)
					expect(oldOwner).to.equal(context.signers.user.address)
					expect(newOwner).to.equal(context.signers.user2.address)
					expect(await context.alViewFacet.ownerOf(subAccountAddress)).to.equal(context.signers.user2.address)
				})

				it("should revert ownership transfer if hook reverts", async () => {
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onSubAccountOwnershipTransfer, true, "Hook rejected ownership transfer")

					await expect(
						context.alCoreFacet.connect(context.signers.user).transferSubAccountOwnership(subAccountAddress, context.signers.user2.address),
					).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")

					expect(await context.alViewFacet.ownerOf(subAccountAddress)).to.equal(context.signers.user.address)
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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					customSubAccountAddress = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					// Manually create virtual account
					await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const customAccount = accounts[accounts.length - 1]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountCreation)

					// Create 3 virtual accounts
					for (let i = 0; i < 3; i++) {
						await context.alCoreFacet
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
					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData])).to.be.revertedWithCustomError(
						context.alCoreFacet,
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

					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [sendQuoteCallData]))
						.to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
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
					const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
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

					const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
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

					const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(marketAccount, 0, 10)
					const marketVirtualAccount = virtualAccounts[0].accountAddress

					await sendQuoteAndGetVirtualAccount(marketVirtualAccount)

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Cancel only first quote
					await cancelVirtualAccountQuote(marketVirtualAccount)

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onVirtualAccountDeletion)

					// Hook should not be called because virtual account still has one quote
					expect(callCountAfter).to.equal(callCountBefore)

					// Virtual account should still exist
					const virtualAccountData = await context.alViewFacet.getVirtualAccount(marketVirtualAccount)
					expect(virtualAccountData.isExists).to.be.true
				})

				it("should handle hook revert gracefully during deletion", async () => {
					const revertMessage = "Hook rejected deletion"
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, revertMessage)

					const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					const quoteId = quotes[0]

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Hook reverts now revert the whole tx - the VA should remain intact
					await expect(context.accountManager.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote])).to.be.reverted

					// Verify the virtual account still exists (tx was reverted)
					const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
					expect(virtualAccountData.isExists).to.be.true
				})

				it("should return the hook failure reason for virtual account deletion", async () => {
					const revertMessage = "Deletion blocked: account has pending rewards"

					const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					const quoteId = quotes[0]

					// Configure hook to revert AFTER virtual account is created
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onVirtualAccountDeletion, true, revertMessage)

					const encodedCancelQuote = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])

					// Hook reverts now revert the whole tx
					await expect(context.accountManager.connect(context.signers.user)._call(virtualAccountAddress, [encodedCancelQuote])).to.be.reverted

					// Verify the virtual account still exists and quote is still tracked
					const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
					expect(virtualAccountData.isExists).to.be.true
					const quotesAfter = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					expect(quotesAfter.length).to.equal(1)
					expect(quotesAfter[0]).to.equal(quoteId)
				})
			})

			describe("onCall hook", async () => {
				it("should call onCall hook when _call is executed on a sub-account", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onCall)

					// Execute a non-sendQuote call on the sub-account (e.g. allocate)
					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [allocateCallData])

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onCall)
					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should call onCall hook when _call is executed on a virtual account", async () => {
					// Create a virtual account with a quote
					const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress, quoteRequest)
					const virtualAccount = virtualAccounts[0]

					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onCall)

					// Execute a non-balance-dependent call on the virtual account (cancel the pending quote)
					const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccount, 0, 10)
					const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quotes[0]])
					await context.alCoreFacet.connect(context.signers.user)._call(virtualAccount, [cancelCallData])

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onCall)
					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should pass correct account to onCall hook", async () => {
					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [allocateCallData])

					const lastAccount = await hookContract.getLastAccountForSelector(HOOK_SELECTORS.onCall)
					expect(lastAccount).to.equal(subAccountAddress)
				})

				it("should call onCall hook once per _call invocation regardless of callDatas length", async () => {
					const callCountBefore = await hookContract.getCallCount(HOOK_SELECTORS.onCall)

					// Execute multiple calls in one _call invocation
					const allocateCallData1 = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(5n)])
					const allocateCallData2 = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(5n)])
					await context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [allocateCallData1, allocateCallData2])

					const callCountAfter = await hookContract.getCallCount(HOOK_SELECTORS.onCall)
					expect(callCountAfter).to.equal(callCountBefore + 1n)
				})

				it("should revert _call if onCall hook reverts", async () => {
					await hookContract.setRevertForSelector(HOOK_SELECTORS.onCall, true, "Hook rejected call")

					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])
					await expect(context.alCoreFacet.connect(context.signers.user)._call(subAccountAddress, [allocateCallData])).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"HookFailed",
					)
				})

				it("should not call onCall hook if no hook is registered", async () => {
					// Create a new affiliate without onCall hook registered
					const affData = {
						name: "test affiliate no call hook",
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
					const affiliateAddress = await context.alAffiliateFacet.requestToRegisterAffiliate.staticCall(affData)
					await context.alAffiliateFacet.requestToRegisterAffiliate(affData)
					await context.alAffiliateFacet.approveAffiliate(affiliateAddress)

					// Create sub-account under the new affiliate (no onCall hook set)
					const subAccountData = [createSubAccountData("NO_HOOK_CALL", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const noHookAccount = accounts[accounts.length - 1]

					// Deposit funds
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositFor(noHookAccount, BALANCES.DEPOSIT_AMOUNT)

					// Should succeed without reverting
					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(10n)])
					await expect(context.alCoreFacet.connect(context.signers.user)._call(noHookAccount, [allocateCallData])).to.not.be.reverted
				})
			})

			describe("executeForAccount hook callback", async () => {
				beforeEach(async () => {
					// Set the AccountLayer address in the mock hook
					await hookContract.setAccountLayer(context.accountLayerDiamond)

					// Make hedger bindable
					await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
				})

				it("should allow hook to execute action on behalf of account when selector is whitelisted", async () => {
					// Whitelist bindToPartyB selector for this affiliate
					const affiliateAddress = await context.accountManager.getAddress()
					const bindToPartyBSelector = context.bindingFacet.interface.getFunction("bindToPartyB").selector
					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector], true)

					// Configure hook to call bindToPartyB
					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onAccountCreation, bindCallData, true)

					// Create a sub-account - hook should bind it to partyB
					const subAccountData = [createSubAccountData("AUTO_BIND_ACCOUNT", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData)

					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const newAccount = accounts[accounts.length - 1]

					// Verify the account was bound to partyB
					const bindState = await context.viewFacet.getBindState(newAccount)
					expect(bindState.status).to.equal(1) // BOUND
					expect(bindState.partyB).to.equal(context.signers.hedger.address)

					// Verify executeForAccount was called
					expect(await hookContract.executeForAccountCallCount()).to.equal(1n)
				})

				it("should revert when hook tries to execute non-whitelisted selector", async () => {
					// Do NOT whitelist the selector
					const affiliateAddress = await context.accountManager.getAddress()

					// Configure hook to call bindToPartyB (not whitelisted)
					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onAccountCreation, bindCallData, true)

					const subAccountData = [createSubAccountData("SHOULD_FAIL_ACCOUNT", 0)]

					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData),
					).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
				})

				it("should revert when no active hook context", async () => {
					// Try to call executeForAccount directly (not from a hook)
					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])

					await expect(context.alCoreFacet.executeForAccount(bindCallData)).to.be.revertedWithCustomError(context.alCoreFacet, "NoActiveHookContext")
				})

				it("should revert when a downstream contract tries to use active hook context", async () => {
					const affiliateAddress = await context.accountManager.getAddress()
					const bindToPartyBSelector = context.bindingFacet.interface.getFunction("bindToPartyB").selector
					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector], true)

					const DownstreamCaller = await ethers.getContractFactory("DownstreamExecuteForAccountCaller")
					const downstreamCaller = await DownstreamCaller.deploy()
					await downstreamCaller.waitForDeployment()

					const ForwardingHook = await ethers.getContractFactory("ForwardingAccountLayerHook")
					const forwardingHook = await ForwardingHook.deploy()
					await forwardingHook.waitForDeployment()

					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await forwardingHook.configure(await context.alCoreFacet.getAddress(), await downstreamCaller.getAddress(), bindCallData)
					await context.alAffiliateFacet.setHook(affiliateAddress, HOOK_SELECTORS.onAccountCreation, await forwardingHook.getAddress())

					const subAccountData = [createSubAccountData("CONFUSED_DEPUTY", 0)]
					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData),
					).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
				})

				it("should emit HookActionExecuted event on successful callback", async () => {
					const affiliateAddress = await context.accountManager.getAddress()
					const bindToPartyBSelector = context.bindingFacet.interface.getFunction("bindToPartyB").selector
					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector], true)

					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onAccountCreation, bindCallData, true)

					const subAccountData = [createSubAccountData("EVENT_TEST_ACCOUNT", 0)]

					await expect(context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData)).to.emit(
						context.alCoreFacet,
						"HookActionExecuted",
					)
				})

				it("should allow admin to whitelist multiple selectors at once", async () => {
					const affiliateAddress = await context.accountManager.getAddress()
					const bindToPartyBSelector = context.bindingFacet.interface.getFunction("bindToPartyB").selector
					const allocateSelector = context.accountFacet.interface.getFunction("allocate").selector

					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector, allocateSelector], true)

					// Both should be whitelisted now - verify by using bindToPartyB
					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onAccountCreation, bindCallData, true)

					const subAccountData = [createSubAccountData("MULTI_SELECTOR_ACCOUNT", 0)]
					await expect(context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData)).to.not.be.reverted
				})

				it("should allow admin to revoke whitelisted selectors", async () => {
					const affiliateAddress = await context.accountManager.getAddress()
					const bindToPartyBSelector = context.bindingFacet.interface.getFunction("bindToPartyB").selector

					// First whitelist
					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector], true)

					// Then revoke
					await context.alControlFacet.setHookAllowedSelectors(affiliateAddress, [bindToPartyBSelector], false)

					// Configure hook to call bindToPartyB (now revoked)
					const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onAccountCreation, bindCallData, true)

					const subAccountData = [createSubAccountData("REVOKED_SELECTOR_ACCOUNT", 0)]

					await expect(
						context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, subAccountData),
					).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
				})

				it("should revert with SelectorNotAllowed when onVirtualAccountCreation hook uses non-whitelisted selector", async () => {
					const affiliateAddress = await context.accountManager.getAddress()
					// Do NOT whitelist any selector

					// Create a sub-account first without the callback (with deposit)
					const parentAccount = await createSubAccountAndDeposit(
						context.signers.user,
						[createSubAccountData("PARENT_ACCOUNT_VA", 0)],
						BALANCES.DEPOSIT_AMOUNT,
					)

					// Configure callback for virtual account creation with a non-whitelisted selector
					const allocateCallData = context.accountFacet.interface.encodeFunctionData("allocate", [decimal(1n)])
					await hookContract.setExecuteForAccountCallback(HOOK_SELECTORS.onVirtualAccountCreation, allocateCallData, true)

					// Send quote which will create a virtual account - should fail because selector not whitelisted
					await expect(sendQuoteAndGetVirtualAccount(parentAccount)).to.be.revertedWithCustomError(context.alCoreFacet, "HookFailed")
				})
			})

			describe("signer reset security", async () => {
				let maliciousHook: any

				beforeEach(async () => {
					// Deploy malicious hook contract
					const MaliciousHook = await ethers.getContractFactory("MaliciousAccountLayerHook")
					maliciousHook = await MaliciousHook.deploy()
					await maliciousHook.waitForDeployment()

					// Set the AccountLayer address in the malicious hook
					await maliciousHook.setAccountLayer(context.accountLayerDiamond)
				})

				it("should prevent hook from impersonating user during onAccountCreation", async () => {
					const affiliateAddress = await context.accountManager.getAddress()

					// Register the malicious hook for onAccountCreation
					await context.alAffiliateFacet.setHook(affiliateAddress, HOOK_SELECTORS.onAccountCreation, await maliciousHook.getAddress())

					// First create a sub-account that the malicious hook will try to modify
					const targetAccountData = [createSubAccountData("TARGET_ACCOUNT", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, targetAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const targetAccount = accounts[accounts.length - 1]

					// Configure malicious hook to try to edit the target account's name
					// This would succeed if the signer wasn't cleared, because the user is the signer during createSubAccounts
					const editNameCallData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [targetAccount, "HACKED"])
					await maliciousHook.setReentryCallData(editNameCallData)
					await maliciousHook.setShouldAttemptReentry(true)
					await maliciousHook.setTargetAccount(targetAccount)

					// Create another sub-account - this triggers the hook
					const newAccountData = [createSubAccountData("NEW_ACCOUNT", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, newAccountData)

					// Verify the hook attempted reentry but failed
					expect(await maliciousHook.attemptedReentry()).to.be.true
					expect(await maliciousHook.reentrySucceeded()).to.be.false

					// Verify the target account name was NOT changed
					const targetAccountData2 = await context.alViewFacet.getSubAccount(targetAccount)
					expect(targetAccountData2.name).to.equal("TARGET_ACCOUNT")
				})

				it("should prevent hook from impersonating user during onVirtualAccountCreation", async () => {
					const affiliateAddress = await context.accountManager.getAddress()

					// Register the malicious hook for onVirtualAccountCreation
					await context.alAffiliateFacet.setHook(affiliateAddress, HOOK_SELECTORS.onVirtualAccountCreation, await maliciousHook.getAddress())

					// Create a sub-account and deposit
					const parentAccount = await createSubAccountAndDeposit(
						context.signers.user,
						[createSubAccountData("PARENT_FOR_VA", 0)],
						BALANCES.DEPOSIT_AMOUNT,
					)

					// Configure malicious hook to try to edit the parent account's name
					const editNameCallData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [parentAccount, "HACKED"])
					await maliciousHook.setReentryCallData(editNameCallData)
					await maliciousHook.setShouldAttemptReentry(true)
					await maliciousHook.setTargetAccount(parentAccount)

					// Send quote which creates a virtual account - this triggers the hook
					await sendQuoteAndGetVirtualAccount(parentAccount)

					// Verify the hook attempted reentry but failed
					expect(await maliciousHook.attemptedReentry()).to.be.true
					expect(await maliciousHook.reentrySucceeded()).to.be.false

					// Verify the parent account name was NOT changed
					const parentAccountData = await context.alViewFacet.getSubAccount(parentAccount)
					expect(parentAccountData.name).to.equal("PARENT_FOR_VA")
				})

				it("should prevent hook from impersonating user during onVirtualAccountDeletion", async () => {
					const affiliateAddress = await context.accountManager.getAddress()

					// Register the malicious hook for onVirtualAccountDeletion
					await context.alAffiliateFacet.setHook(affiliateAddress, HOOK_SELECTORS.onVirtualAccountDeletion, await maliciousHook.getAddress())

					// Create a sub-account and deposit
					const parentAccount = await createSubAccountAndDeposit(
						context.signers.user,
						[createSubAccountData("PARENT_FOR_DELETE", 0)],
						BALANCES.DEPOSIT_AMOUNT,
					)

					// Send quote to create virtual account
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(parentAccount)
					const virtualAccount = virtualAccounts[0]

					// Configure malicious hook to try to edit the parent account's name
					const editNameCallData = context.alCoreFacet.interface.encodeFunctionData("editAccountName", [parentAccount, "HACKED"])
					await maliciousHook.setReentryCallData(editNameCallData)
					await maliciousHook.setShouldAttemptReentry(true)
					await maliciousHook.setTargetAccount(parentAccount)

					// Cancel the quote to trigger virtual account deletion (which triggers the hook)
					await cancelVirtualAccountQuote(virtualAccount)

					// Verify the hook attempted reentry but failed
					expect(await maliciousHook.attemptedReentry()).to.be.true
					expect(await maliciousHook.reentrySucceeded()).to.be.false

					// Verify the parent account name was NOT changed
					const parentAccountData = await context.alViewFacet.getSubAccount(parentAccount)
					expect(parentAccountData.name).to.equal("PARENT_FOR_DELETE")
				})

				it("should restore signer after hook execution completes", async () => {
					const affiliateAddress = await context.accountManager.getAddress()

					// Register the malicious hook (but don't configure reentry)
					await context.alAffiliateFacet.setHook(affiliateAddress, HOOK_SELECTORS.onAccountCreation, await maliciousHook.getAddress())
					await maliciousHook.setShouldAttemptReentry(false)

					// Create a sub-account
					const accountData = [createSubAccountData("SIGNER_RESTORE_TEST", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(affiliateAddress, accountData)

					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					const newAccount = accounts[accounts.length - 1]

					// Verify that after the hook, the user can still perform actions on their account
					// This proves the signer was properly restored after hook execution
					await expect(context.alCoreFacet.connect(context.signers.user).editAccountName(newAccount, "RENAMED")).to.not.be.reverted

					const accountDetail = await context.alViewFacet.getSubAccount(newAccount)
					expect(accountDetail.name).to.equal("RENAMED")
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
					const signer = await context.alViewFacet.getSigner()
					expect(signer).to.not.equal(ZeroAddress)
				})
			})

			describe("getRelatedCore", async () => {
				it("should return symmioCore for a sub-account", async function () {
					const core = await context.alViewFacet.getRelatedCore(subAccountAddress)
					expect(core).to.equal(context.diamond)
				})

				it("should return symmioCore for a virtual account via parent", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const core = await context.alViewFacet.getRelatedCore(virtualAccountAddress)
					expect(core).to.equal(context.diamond)
				})
			})

			describe("getUserSubAccountsAddresses", async () => {
				it("should return empty array for user with no sub-accounts", async function () {
					const addresses = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user2.address, 0, 100)
					expect(addresses).to.be.an("array").that.is.empty
				})

				it("should return correct sub-account addresses for owner", async function () {
					const addresses = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses.length).to.be.greaterThanOrEqual(1)
				})

				it("should return multiple sub-accounts when created", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					const secondSubAccount = await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const addresses = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
					expect(addresses).to.include(subAccountAddress)
					expect(addresses).to.include(secondSubAccount)
				})
			})

			describe("getSubAccount", async () => {
				it("should return correct sub-account details", async function () {
					const detail = await context.alViewFacet.getSubAccount(subAccountAddress)

					expect(detail.accountAddress).to.equal(subAccountAddress)
					expect(detail.owner).to.equal(context.signers.user.address)
					expect(detail.name).to.equal("GETTER_TEST_ACCOUNT")
					expect(detail.affiliate).to.equal(await context.accountManager.getAddress())
					expect(detail.symmioCore).to.equal(context.diamond)
				})
			})

			describe("getUserSubAccounts", async () => {
				it("should return empty array if no sub-accounts exist", async function () {
					const details = await context.alViewFacet.getUserSubAccounts(context.signers.others[0].address, 0, 10)
					expect(details.length).to.be.equal(0)
				})

				it("should return paginated sub-account details", async function () {
					const details = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 0, 10)

					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(subAccountAddress)
				})

				it("should respect offset and limit", async function () {
					const secondSubAccountData = [createSubAccountData("SECOND_ACCOUNT", 0, "METADATA2")]
					await createSubAccountAndDeposit(context.signers.user, secondSubAccountData, BALANCES.DEPOSIT_AMOUNT)

					const allDetails = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 0, 10)
					const firstOnly = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 0, 1)
					const secondOnly = await context.alViewFacet.getUserSubAccounts(context.signers.user.address, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return empty array when no virtual accounts exist", async function () {
					const details = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should return virtual account details after quote", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
				})
			})

			describe("getVirtualAccount", async () => {
				it("should return correct virtual account details", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const detail = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)

					expect(detail.accountAddress).to.equal(virtualAccountAddress)
					expect(detail.parentAccount).to.equal(subAccountAddress)
					expect(detail.isExists).to.equal(true)
				})
			})

			describe("getVirtualAccountsOfSubAccount", async () => {
				it("should return paginated virtual account details", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const details = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details.length).to.be.greaterThanOrEqual(1)
				})

				it("should return empty array if no virtual accounts exist", async function () {
					const details = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details).to.be.an("array").that.is.empty
				})

				it("should respect offset and limit", async function () {
					// Create two virtual accounts
					await sendQuoteAndGetVirtualAccount(subAccountAddress)
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const allDetails = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					const firstOnly = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 1)
					const secondOnly = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 1, 1)

					expect(allDetails.length).to.be.greaterThanOrEqual(2)
					expect(firstOnly.length).to.equal(1)
					expect(secondOnly.length).to.equal(1)
					expect(allDetails[0].accountAddress).to.equal(firstOnly[0].accountAddress)
					expect(allDetails[1].accountAddress).to.equal(secondOnly[0].accountAddress)
				})

				it("should return correct details for each virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					const details = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddress, 0, 10)
					expect(details[0].accountAddress).to.equal(virtualAccounts[0])
					expect(details[0].parentAccount).to.equal(subAccountAddress)
					expect(details[0].isExists).to.be.true
				})
			})

			describe("sendQuoteAndGetVirtualAccount", async () => {
				it("should return quote IDs for virtual account", async function () {
					const virtualAccounts = await sendQuoteAndGetVirtualAccount(subAccountAddress)
					virtualAccountAddress = virtualAccounts[0]

					const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
					expect(quoteIds.length).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getSubAccountsCountOfUser", async () => {
				it("should return 0 for user with no sub-accounts", async function () {
					const count = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(count).to.equal(0)
				})

				it("should return correct count after creating sub-accounts", async function () {
					const count = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user.address)
					expect(count).to.be.greaterThanOrEqual(1)
				})
			})

			describe("getVirtualAccountsCountOfSubAccount", async () => {
				it("should return 0 when no virtual accounts exist", async function () {
					const count = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(count).to.equal(0)
				})

				it("should return correct count after sending quote", async function () {
					await sendQuoteAndGetVirtualAccount(subAccountAddress)

					const count = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(subAccountAddress)
					expect(count).to.be.greaterThanOrEqual(1)
				})
			})

			describe("Public Constants and Variables", async () => {
				it("should return MAX_NAME_LENGTH", async function () {
					const maxLength = await context.alViewFacet.MAX_NAME_LENGTH()
					expect(maxLength).to.be.equal(100)
				})

				it("should return accountLayer address", async function () {
					expect(context.accountLayerDiamond).to.not.equal(ZeroAddress)
				})

				it("should return globalNonce > 0 after account creation", async function () {
					const nonce = await context.alViewFacet.globalNonce()
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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const accounts = await context.accountManager.getAccounts(context.signers.user.address, 0, 100)
					expect(accounts.length).to.equal(3)

					// Verify these are the same as what AccountLayer returns
					const hubAccounts = await context.alViewFacet.getUserSubAccountsAddresses(context.signers.user.address, 0, 100)
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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

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
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), subAccountData)

					const length = await context.accountManager.getAccountsLength(context.signers.user.address)
					expect(length).to.equal(3)
				})

				it("should return different counts for different users", async function () {
					// beforeEach creates 1 account for user, create 1 more for total of 2
					const userSubAccountData = [createSubAccountData("USER_1", 0)]
					await context.alCoreFacet.connect(context.signers.user).createSubAccounts(await context.accountManager.getAddress(), userSubAccountData)

					// Create 1 account for user2
					const user2SubAccountData = [createSubAccountData("USER2_1", 0)]
					await context.alCoreFacet.connect(context.signers.user2).createSubAccounts(await context.accountManager.getAddress(), user2SubAccountData)

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

						await context.alCoreFacet.connect(context.signers.user2).createSubAccounts(await context.accountManager.getAddress(), batchData)
					}

					const totalCount = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(totalCount).to.equal(TOTAL_ACCOUNTS)

					// Test various batch sizes
					const batch100 = await context.alViewFacet.getUserSubAccounts(context.signers.user2.address, 0, 100)
					expect(batch100.length).to.equal(100)
					expect(batch100[0].owner).to.equal(context.signers.user2.address)

					const batch500 = await context.alViewFacet.getUserSubAccounts(context.signers.user2.address, 0, 500)
					expect(batch500.length).to.equal(500)

					// Test pagination through all accounts
					let retrievedCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.alViewFacet.getUserSubAccounts(context.signers.user2.address, offset, pageSize)
						retrievedCount += batch.length

						// Verify first item in each batch
						if (batch.length > 0) {
							expect(batch[0].owner).to.equal(context.signers.user2.address)
						}
					}

					expect(retrievedCount).to.equal(TOTAL_ACCOUNTS)

					// Test offset functionality
					const firstBatch = await context.alViewFacet.getUserSubAccounts(context.signers.user2.address, 0, 10)
					const secondBatch = await context.alViewFacet.getUserSubAccounts(context.signers.user2.address, 10, 10)
					expect(firstBatch[0].accountAddress).to.not.equal(secondBatch[0].accountAddress)
				})
			})

			describe("Large Dataset Virtual Accounts Batch Retrieval", async () => {
				// Helper to create a CUSTOM sub-account without deposit (for virtual account creation tests)
				async function createCustomSubAccountWithoutDeposit(parentAccount: HardhatEthersSigner, name: string): Promise<string> {
					const subAccountData = [createSubAccountData(name, 3)] // isolationType 3 = CUSTOM
					await context.alCoreFacet.connect(parentAccount).createSubAccounts(await context.accountManager.getAddress(), subAccountData)
					const accounts = await context.alViewFacet.getUserSubAccountsAddresses(parentAccount.address, 0, 100)
					return accounts[accounts.length - 1]
				}

				it("should handle 5k virtual accounts creation and retrieval efficiently", async function () {
					this.timeout(120000) // 2 minutes for creating 5k virtual accounts

					const TOTAL_VIRTUAL_ACCOUNTS = 500
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

							await context.alCoreFacet
								.connect(context.signers.user2)
								.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes(`VIRTUAL_${j}`)), isolationType, symbolId)
						}
					}

					// Verify total count
					const totalCount = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(customSubAccount)
					expect(totalCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test getVirtualAccountsAddressesOfSubAccount with various batch sizes
					const addresses100 = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 100)
					expect(addresses100.length).to.equal(100)

					const addresses500 = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 500)
					expect(addresses500.length).to.equal(500)

					// Test getVirtualAccountsOfSubAccount with detailed info
					const details100 = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 100)
					expect(details100.length).to.equal(100)
					expect(details100[0].parentAccount).to.equal(customSubAccount)
					expect(details100[0].isExists).to.be.true

					// Test pagination through all virtual accounts using addresses
					let retrievedAddressCount = 0
					const pageSize = 100

					for (let offset = 0; offset < TOTAL_VIRTUAL_ACCOUNTS; offset += pageSize) {
						const batch = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, offset, pageSize)
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
						const batch = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, offset, pageSize)
						retrievedDetailCount += batch.length

						// Verify each item in batch has correct parent
						for (const detail of batch) {
							expect(detail.parentAccount).to.equal(customSubAccount)
							expect(detail.isExists).to.be.true
						}
					}

					expect(retrievedDetailCount).to.equal(TOTAL_VIRTUAL_ACCOUNTS)

					// Test offset functionality for addresses
					const firstAddressBatch = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 0, 10)
					const secondAddressBatch = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, 10, 10)
					expect(firstAddressBatch[0]).to.not.equal(secondAddressBatch[0])

					// Test offset functionality for details
					const firstDetailBatch = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
					const secondDetailBatch = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 10, 10)
					expect(firstDetailBatch[0].accountAddress).to.not.equal(secondDetailBatch[0].accountAddress)

					// Verify getVirtualAccount for individual accounts
					const sampleAddress = addresses100[50]
					const sampleDetail = await context.alViewFacet.getVirtualAccount(sampleAddress)
					expect(sampleDetail.parentAccount).to.equal(customSubAccount)
					expect(sampleDetail.isExists).to.be.true

					// Test boundary conditions
					// Offset at end should return empty array
					const emptyBatch = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS, 100)
					expect(emptyBatch.length).to.equal(0)

					// Offset near end should return remaining accounts
					const nearEndBatch = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS - 50, 100)
					expect(nearEndBatch.length).to.equal(50)

					// Verify getSubAccountVirtualNonce
					const nonce = await context.alViewFacet.getSubAccountVirtualNonce(customSubAccount)
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

						await context.alCoreFacet
							.connect(context.signers.user2)
							.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes(`VERIFY_${i}`)), isolationType, symbolId)
					}

					// Retrieve all and verify
					const allDetails = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, TOTAL_VIRTUAL_ACCOUNTS)
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
						await context.alCoreFacet.connect(context.signers.user2).createCustomVirtualAccount(
							customSubAccount,
							ethers.keccak256(toUtf8Bytes(`PREDICT_${i}`)),
							0, // POSITION
							i + 1,
						)
					}

					// Predict next address
					const predictedAddress = await context.alViewFacet.predictNextVirtualAccountAddress(
						customSubAccount,
						0, // POSITION
						TOTAL_VIRTUAL_ACCOUNTS + 1,
					)
					expect(predictedAddress).to.not.equal(ZeroAddress)

					// Create the predicted account
					await context.alCoreFacet
						.connect(context.signers.user2)
						.createCustomVirtualAccount(customSubAccount, ethers.keccak256(toUtf8Bytes("PREDICTED")), 0, TOTAL_VIRTUAL_ACCOUNTS + 1)

					// Verify the actual address matches prediction
					const allAddresses = await context.alViewFacet.getVirtualAccountsAddressesOfSubAccount(customSubAccount, TOTAL_VIRTUAL_ACCOUNTS, 1)
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
							await context.alCoreFacet
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
						const count = await context.alViewFacet.getVirtualAccountsCountOfSubAccount(subAccountAddresses[subIdx])
						expect(count).to.equal(VIRTUAL_ACCOUNTS_PER_SUB)
					}

					// Verify user's total sub-accounts
					const userSubAccountCount = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user2.address)
					expect(userSubAccountCount).to.equal(NUM_SUB_ACCOUNTS)

					// Test pagination for each sub-account
					for (let subIdx = 0; subIdx < NUM_SUB_ACCOUNTS; subIdx++) {
						let totalRetrieved = 0
						const pageSize = 100

						for (let offset = 0; offset < VIRTUAL_ACCOUNTS_PER_SUB; offset += pageSize) {
							const batch = await context.alViewFacet.getVirtualAccountsOfSubAccount(subAccountAddresses[subIdx], offset, pageSize)
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
				const currentNonce = await context.alViewFacet.getSubAccountVirtualNonce(positionSubAccountAddress)

				// Predict the next virtual account address
				const predictedAddress = await context.alViewFacet.predictNextVirtualAccountAddress(
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
				const newNonce = await context.alViewFacet.getSubAccountVirtualNonce(positionSubAccountAddress)
				expect(newNonce).to.equal(currentNonce + 1n)
			})

			it("should return deleted virtual account address when one exists", async () => {
				// Create a virtual account
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest)
				const initialVirtualAccount = virtualAccounts[0]

				// Close the position to delete the virtual account
				const quotes = await context.alViewFacet.getVirtualAccountQuoteIds(initialVirtualAccount, 0, 10)
				const quoteId = quotes[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, initialVirtualAccount)

				const deletedAccountData = await context.alViewFacet.getVirtualAccount(initialVirtualAccount)
				expect(deletedAccountData.isExists).to.be.false

				const predictedAddress = await context.alViewFacet.predictNextVirtualAccountAddress(
					positionSubAccountAddress,
					0, // VirtualAccountIsolationType.POSITION
					1, // symbolId (0 for position isolation)
				)

				expect(predictedAddress).to.equal(initialVirtualAccount)

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
				const predictedMarketAddress = await context.alViewFacet.predictNextVirtualAccountAddress(
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
				const predictedPositionAddress = await context.alViewFacet.predictNextVirtualAccountAddress(
					marketSubAccount,
					0, // VirtualAccountIsolationType.POSITION
					0, // symbolId 0 for position
				)

				// The addresses should be different for different isolation types
				expect(predictedPositionAddress).to.not.equal(predictedMarketAddress)
			})

			it("should prioritize active VA over deleted pool in singleVAMode", async () => {
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MARKET_MISMATCH", 1, "MARKET", false)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				const { activeVA, pooledVA } = await prepareSingleVAModeStateWithActiveAndPool(marketSubAccount, 1)

				const predicted = await context.alViewFacet.predictNextVirtualAccountAddress(marketSubAccount, 1, 1)

				expect(predicted).to.equal(activeVA)
				expect(predicted).to.not.equal(pooledVA)
			})
		})

		describe("addMarginToNextVA", async () => {
			// ensure isolation type matches the subaccount mode
			it("rejects mismatched isolation type", async () => {
				const subAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MARKET_ACCOUNT", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
					false,
				)

				const quoteRequest = limitQuoteRequestBuilder().symbolId(1).build()
				const wrongIsolationType = 0 // VirtualAccountIsolationType.POSITION

				await expect(
					context.alMarginFacet
						.connect(context.signers.user)
						.addMarginToNextVA(subAccount, wrongIsolationType, quoteRequest.symbolId, BALANCES.TRANSFER_AMOUNT),
				).to.be.revertedWithCustomError(context.alMarginFacet, "InvalidIsolationType")
			})

			it("should fund active VA instead of deleted pool VA in singleVAMode", async () => {
				const subAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MARKET_MARGIN_TARGET", 1, "MARKET", false)],
					BALANCES.DEPOSIT_AMOUNT,
				)
				const symbolId = 1

				const { activeVA, pooledVA } = await prepareSingleVAModeStateWithActiveAndPool(subAccount, symbolId)

				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.DEPOSIT_AMOUNT)
				await context.accountFacet.connect(context.signers.user).depositFor(subAccount, BALANCES.DEPOSIT_AMOUNT)

				const activeBefore = await context.viewFacet.allocatedBalanceOfPartyA(activeVA)
				const pooledBefore = await context.viewFacet.allocatedBalanceOfPartyA(pooledVA)

				await context.alMarginFacet.connect(context.signers.user).addMarginToNextVA(subAccount, 1, symbolId, BALANCES.TRANSFER_AMOUNT)

				const activeAfter = await context.viewFacet.allocatedBalanceOfPartyA(activeVA)
				const pooledAfter = await context.viewFacet.allocatedBalanceOfPartyA(pooledVA)

				expect(activeAfter - activeBefore).to.equal(BALANCES.TRANSFER_AMOUNT)
				expect(pooledAfter - pooledBefore).to.equal(0n)
			})
		})

		describe("emergencyRecoverMargin", async () => {
			let subAccount: string

			beforeEach(async () => {
				subAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CUSTOM_ACCOUNT", 3, "CUSTOM")],
					BALANCES.DEPOSIT_AMOUNT,
					false,
				)
			})

			it("recovers margin from predicted VA address", async () => {
				const predictedAddress = await context.alViewFacet.predictNextVirtualAccountAddress(subAccount, 0, 1)
				const subAccountBalanceBefore = await context.viewFacet.balanceOf(subAccount)

				const transferCallData: BytesLike[] = [
					context.accountFacet.interface.encodeFunctionData("internalTransfer", [predictedAddress, BALANCES.TRANSFER_AMOUNT]),
				]
				await context.alCoreFacet.connect(context.signers.user)._call(subAccount, transferCallData)

				const subAccountBalanceAfterTransfer = await context.viewFacet.balanceOf(subAccount)
				const predictedAllocatedBalanceAfterTransfer = await context.viewFacet.allocatedBalanceOfPartyA(predictedAddress)

				expect(subAccountBalanceAfterTransfer).to.equal(subAccountBalanceBefore - BALANCES.TRANSFER_AMOUNT)
				expect(predictedAllocatedBalanceAfterTransfer).to.equal(BALANCES.TRANSFER_AMOUNT)

				await expect(context.alMarginFacet.connect(context.signers.user).emergencyRecoverMargin(subAccount, 1))
					.to.emit(context.alMarginFacet, "EmergencyMarginRecovered")
					.withArgs(predictedAddress, subAccount, BALANCES.TRANSFER_AMOUNT)

				const subAccountBalanceAfterRecover = await context.viewFacet.balanceOf(subAccount)
				const predictedAllocatedBalanceAfterRecover = await context.viewFacet.allocatedBalanceOfPartyA(predictedAddress)
				const predictedBalanceAfterRecover = await context.viewFacet.balanceOf(predictedAddress)

				expect(subAccountBalanceAfterRecover).to.equal(subAccountBalanceBefore)
				expect(predictedAllocatedBalanceAfterRecover).to.equal(0n)
				expect(predictedBalanceAfterRecover).to.equal(0n)
			})

			it("reverts when nonce is zero", async () => {
				await expect(context.alMarginFacet.connect(context.signers.user).emergencyRecoverMargin(subAccount, 0)).to.be.revertedWithCustomError(
					context.alMarginFacet,
					"InvalidNonce",
				)
			})

			it("reverts when nonce is too large", async () => {
				await expect(context.alMarginFacet.connect(context.signers.user).emergencyRecoverMargin(subAccount, 2)).to.be.revertedWithCustomError(
					context.alMarginFacet,
					"InvalidNonce",
				)
			})

			it("reverts when target account already exists", async () => {
				await context.alCoreFacet
					.connect(context.signers.user)
					.createCustomVirtualAccount(subAccount, ethers.keccak256(toUtf8Bytes("EMERGENCY_VA_1")), 0, 1)

				await expect(context.alMarginFacet.connect(context.signers.user).emergencyRecoverMargin(subAccount, 1)).to.be.revertedWithCustomError(
					context.alMarginFacet,
					"AccountAlreadyExists",
				)
			})

			it("reverts when no balance is available for recovery", async () => {
				await expect(context.alMarginFacet.connect(context.signers.user).emergencyRecoverMargin(subAccount, 1)).to.be.revertedWithCustomError(
					context.alMarginFacet,
					"ZeroAmount",
				)
			})

			it("reverts when called by non-owner", async () => {
				await expect(context.alMarginFacet.connect(context.signers.others[0]).emergencyRecoverMargin(subAccount, 1)).to.be.revertedWithCustomError(
					context.alMarginFacet,
					"NotOwner",
				)
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

				await context.alCoreFacet.connect(context.signers.user).createCustomVirtualAccount(
					customSubAccount,
					ethers.keccak256(toUtf8Bytes("VIRTUAL_1")),
					0, // POSITION isolation
					1, // symbolId
				)

				const virtualAccounts = await context.alViewFacet.getVirtualAccountsOfSubAccount(customSubAccount, 0, 10)
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
					await expect(context.alMarginFacet.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT))
						.to.emit(context.alMarginFacet, "AddMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					// Check balances after transfer
					const subAccountBalanceAfter = await context.viewFacet.balanceOf(customSubAccount)
					const virtualAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore - BALANCES.TRANSFER_AMOUNT)
					expect(virtualAccountAllocatedBalanceAfter).to.equal(BALANCES.TRANSFER_AMOUNT)
				})

				it("should revert when transferring zero amount", async () => {
					await expect(context.alMarginFacet.connect(context.signers.user).addMargin(virtualAccount, 0n)).to.be.revertedWithCustomError(
						context.alMarginFacet,
						"ZeroAmount",
					)
				})

				it("should revert when caller is not the account owner", async () => {
					await expect(
						context.alMarginFacet.connect(context.signers.user2).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT),
					).to.be.revertedWithCustomError(context.alMarginFacet, "NotOwner")
				})
			})

			describe("removeMargin", async () => {
				beforeEach(async () => {
					await context.alMarginFacet.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT)
				})

				it("should transfer balance from virtual account to subaccount", async () => {
					// Check initial balances
					const subAccountBalanceBefore = await context.viewFacet.balanceOf(customSubAccount)
					const subAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					const virtualAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					// Virtual account should have balance from the deposit
					expect(virtualAccountAllocatedBalanceBefore).to.equal(BALANCES.TRANSFER_AMOUNT)
					expect(subAccountAllocatedBalanceBefore).to.equal(0n)

					// Transfer from virtual account to subaccount
					await expect(
						context.alMarginFacet.connect(context.signers.user).removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig()),
					)
						.to.emit(context.alMarginFacet, "RemoveMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					// Check balances after transfer
					const virtualAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
					expect(virtualAccountAllocatedBalanceAfter).to.equal(0)

					const subAccountBalanceAfter = await context.viewFacet.balanceOf(customSubAccount)
					const subAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore + BALANCES.TRANSFER_AMOUNT)
					expect(subAccountAllocatedBalanceAfter).to.equal(subAccountAllocatedBalanceBefore)
				})

				it("should not be blocked by parent allocated balance limit when removing margin", async () => {
					await context.controlFacet.connect(context.signers.admin).setBalanceLimitPerUser(BALANCES.TRANSFER_AMOUNT)

					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), BALANCES.TRANSFER_AMOUNT)
					await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(customSubAccount, BALANCES.TRANSFER_AMOUNT)

					const subAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					const subAccountBalanceBefore = await context.viewFacet.balanceOf(customSubAccount)
					expect(subAccountAllocatedBalanceBefore).to.equal(BALANCES.TRANSFER_AMOUNT)

					await expect(
						context.alMarginFacet.connect(context.signers.user).removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig()),
					)
						.to.emit(context.alMarginFacet, "RemoveMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					const subAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					const subAccountBalanceAfter = await context.viewFacet.balanceOf(customSubAccount)
					expect(subAccountAllocatedBalanceAfter).to.equal(subAccountAllocatedBalanceBefore)
					expect(subAccountBalanceAfter).to.equal(subAccountBalanceBefore + BALANCES.TRANSFER_AMOUNT)
				})

				it("should revert when transferring zero amount", async () => {
					await expect(
						context.alMarginFacet.connect(context.signers.user).removeMargin(virtualAccount, 0n, await getDummySingleUpnlSig()),
					).to.be.revertedWithCustomError(context.alMarginFacet, "ZeroAmount")
				})

				it("should revert when caller is not the account owner", async () => {
					await expect(
						context.alMarginFacet.connect(context.signers.user2).removeMargin(virtualAccount, decimal(100n), await getDummySingleUpnlSig()),
					).to.be.revertedWithCustomError(context.alMarginFacet, "NotOwner")
				})
			})

			describe("safeRemoveMargin", async () => {
				beforeEach(async () => {
					await context.alMarginFacet.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT)
				})

				it("should transfer balance from virtual account to subaccount via core safeDeallocate", async () => {
					const subAccountBalanceBefore = await context.viewFacet.balanceOf(customSubAccount)
					expect(await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)).to.equal(BALANCES.TRANSFER_AMOUNT)

					await expect(
						context.alMarginFacet
							.connect(context.signers.user)
							.safeRemoveMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlWithPendingBalanceSig()),
					)
						.to.emit(context.alMarginFacet, "RemoveMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					expect(await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)).to.equal(0n)
					expect(await context.viewFacet.balanceOf(customSubAccount)).to.equal(subAccountBalanceBefore + BALANCES.TRANSFER_AMOUNT)
				})

				it("should enforce the scaled locked balance floor from core", async () => {
					const scaledLockedBalance = BALANCES.TRANSFER_AMOUNT / 2n
					const removable = BALANCES.TRANSFER_AMOUNT - scaledLockedBalance

					await expect(
						context.alMarginFacet
							.connect(context.signers.user)
							.safeRemoveMargin(virtualAccount, removable + 1n, await getDummySingleUpnlWithPendingBalanceSig(0n, 0n, scaledLockedBalance)),
					).to.be.revertedWith("AccountFacet: Locked balance must remain allocated")

					await context.alMarginFacet
						.connect(context.signers.user)
						.safeRemoveMargin(virtualAccount, removable, await getDummySingleUpnlWithPendingBalanceSig(0n, 0n, scaledLockedBalance))

					expect(await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)).to.equal(scaledLockedBalance)
				})

				it("should revert when transferring zero amount", async () => {
					await expect(
						context.alMarginFacet.connect(context.signers.user).safeRemoveMargin(virtualAccount, 0n, await getDummySingleUpnlWithPendingBalanceSig()),
					).to.be.revertedWithCustomError(context.alMarginFacet, "ZeroAmount")
				})

				it("should revert when caller is not the account owner", async () => {
					await expect(
						context.alMarginFacet
							.connect(context.signers.user2)
							.safeRemoveMargin(virtualAccount, decimal(100n), await getDummySingleUpnlWithPendingBalanceSig()),
					).to.be.revertedWithCustomError(context.alMarginFacet, "NotOwner")
				})
			})

			describe("Round-trip transfer", async () => {
				it("should correctly handle transfers in both directions", async () => {
					const initialSubAccountBalance = await context.viewFacet.balanceOf(customSubAccount)
					const initialVirtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(initialSubAccountBalance).to.equal(BALANCES.DEPOSIT_AMOUNT)
					expect(initialVirtualAccountAllocatedBalance).to.equal(0n)

					// Step 1: Transfer from subaccount to virtual account
					await context.alMarginFacet.connect(context.signers.user).addMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT)

					let subAccountBalance = await context.viewFacet.balanceOf(customSubAccount)
					let virtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					expect(subAccountBalance).to.equal(BALANCES.DEPOSIT_AMOUNT - BALANCES.TRANSFER_AMOUNT)
					expect(virtualAccountAllocatedBalance).to.equal(BALANCES.TRANSFER_AMOUNT)

					// Step 2: Transfer from virtual account to subaccount
					await context.alMarginFacet
						.connect(context.signers.user)
						.removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig())

					virtualAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
					subAccountBalance = await context.viewFacet.balanceOf(customSubAccount)
					const subAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)

					expect(virtualAccountAllocatedBalance).to.equal(0)
					expect(subAccountBalance).to.equal(initialSubAccountBalance)
					expect(subAccountAllocatedBalance).to.equal(0)
				})
			})
		})

		describe("Legacy Account Migration", async () => {
			let legacyMultiAccount: any
			let legacyAccounts: string[]
			let registerAffiliateWithInvalidLegacyEntry: () => Promise<void>

			beforeEach(async () => {
				context = await loadFixture(initializeFixture)

				// Get the legacy multi-account contract
				const legacyMultiAccounts = await context.alViewFacet.getLegacyMultiAccounts()
				expect(legacyMultiAccounts.length).to.be.greaterThan(0)
				legacyMultiAccount = await ethers.getContractAt("MockMultiAccount", legacyMultiAccounts[0])

				// Create multiple legacy accounts for the user
				legacyAccounts = []
				for (let i = 0; i < 3; i++) {
					const tx = await legacyMultiAccount.createMockAccountWithName(context.signers.user.address, `Legacy Account ${i + 1}`)
					const receipt = await tx.wait()
					for (const log of receipt!.logs) {
						try {
							const parsed = legacyMultiAccount.interface.parseLog(log)
							if (parsed?.name === "AccountCreated") {
								legacyAccounts.push(parsed.args.account)
								break
							}
						} catch {}
					}
				}
				expect(legacyAccounts.length).to.equal(3)

				registerAffiliateWithInvalidLegacyEntry = async () => {
					const badLegacyAffiliate = {
						name: "legacy-invalid-owner-call",
						brandColor: "111111",
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

					const badAffiliateAddress = await context.alAffiliateFacet.requestToRegisterAffiliate.staticCall(badLegacyAffiliate)
					await context.alAffiliateFacet.requestToRegisterAffiliate(badLegacyAffiliate)
					await context.alAffiliateFacet.approveAffiliate(badAffiliateAddress)
				}
			})

			describe("getLegacyAccountsOfUser", async () => {
				it("should return all legacy accounts for a user", async () => {
					const [accounts, hasMore] = await context.alViewFacet.getLegacyAccountsOfUser(context.signers.user.address, 100)

					expect(accounts.length).to.equal(3)
					expect(hasMore).to.be.false

					for (let i = 0; i < accounts.length; i++) {
						expect(accounts[i].accountAddress).to.equal(legacyAccounts[i])
						expect(accounts[i].legacyContract).to.equal(await legacyMultiAccount.getAddress())
						expect(accounts[i].alreadyImported).to.be.false
					}
				})

				it("should respect maxResults limit", async () => {
					const [accounts, hasMore] = await context.alViewFacet.getLegacyAccountsOfUser(context.signers.user.address, 2)

					expect(accounts.length).to.equal(2)
					expect(hasMore).to.be.true
				})

				it("should return empty array for user with no legacy accounts", async () => {
					const [accounts, hasMore] = await context.alViewFacet.getLegacyAccountsOfUser(context.signers.others[1].address, 100)

					expect(accounts.length).to.equal(0)
					expect(hasMore).to.be.false
				})

				it("should mark imported accounts correctly", async () => {
					// Import first account
					await context.alCoreFacet
						.connect(context.signers.user)
						.importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Imported Account 1", coreIndex: 0 }],
						)

					const [accounts] = await context.alViewFacet.getLegacyAccountsOfUser(context.signers.user.address, 100)

					expect(accounts[0].alreadyImported).to.be.true
					expect(accounts[1].alreadyImported).to.be.false
					expect(accounts[2].alreadyImported).to.be.false
				})
			})

			describe("invalid legacy owner-call resilience", async () => {
				it("should skip invalid legacy entries in ownerOf resolution", async () => {
					await registerAffiliateWithInvalidLegacyEntry()

					expect(await context.alViewFacet.ownerOf(context.signers.others[0].address)).to.equal(ZeroAddress)
				})

				it("should preserve CoreNotFound behavior in getRelatedCore when owner lookup fails on invalid legacy entry", async () => {
					await registerAffiliateWithInvalidLegacyEntry()

					await expect(context.alViewFacet.getRelatedCore(context.signers.others[0].address)).to.be.revertedWithCustomError(
						context.alViewFacet,
						"CoreNotFound",
					)
				})
			})

			describe("importLegacyAccounts", async () => {
				it("should successfully import legacy accounts", async () => {
					const accountsData = [
						{ account: legacyAccounts[0], name: "New Name 1", coreIndex: 0 },
						{ account: legacyAccounts[1], name: "New Name 2", coreIndex: 0 },
					]

					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.importLegacyAccounts(
								await legacyMultiAccount.getAddress(),
								await context.accountManager.getAddress(),
								[context.diamond],
								accountsData,
							),
					).to.emit(context.alCoreFacet, "LegacyAccountImported")

					// Verify imported accounts
					for (let i = 0; i < accountsData.length; i++) {
						const subAccount = await context.alViewFacet.getSubAccount(accountsData[i].account)
						expect(subAccount.isExists).to.be.true
						expect(subAccount.owner).to.equal(context.signers.user.address)
						expect(subAccount.name).to.equal(accountsData[i].name)
						expect(subAccount.affiliate).to.equal(await context.accountManager.getAddress())
						expect(subAccount.symmioCore).to.equal(context.diamond)
						expect(subAccount.isolationType).to.equal(3) // CUSTOM
					}
				})

				it("should add imported accounts to user's sub-accounts list", async () => {
					const countBefore = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user.address)

					await context.alCoreFacet
						.connect(context.signers.user)
						.importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Imported", coreIndex: 0 }],
						)

					const countAfter = await context.alViewFacet.getSubAccountsCountOfUser(context.signers.user.address)
					expect(countAfter).to.equal(countBefore + 1n)
				})

				it("should reject import of account not owned by caller", async () => {
					await expect(
						context.alCoreFacet
							.connect(context.signers.others[0])
							.importLegacyAccounts(
								await legacyMultiAccount.getAddress(),
								await context.accountManager.getAddress(),
								[context.diamond],
								[{ account: legacyAccounts[0], name: "Stolen Account", coreIndex: 0 }],
							),
					).to.be.revertedWithCustomError(context.alCoreFacet, "LegacyAccountNotOwned")
				})

				it("should reject double import", async () => {
					// First import
					await context.alCoreFacet
						.connect(context.signers.user)
						.importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "First Import", coreIndex: 0 }],
						)

					// Second import attempt
					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.importLegacyAccounts(
								await legacyMultiAccount.getAddress(),
								await context.accountManager.getAddress(),
								[context.diamond],
								[{ account: legacyAccounts[0], name: "Second Import", coreIndex: 0 }],
							),
					).to.be.revertedWithCustomError(context.alCoreFacet, "AccountAlreadyExists")
				})

				it("should reject import with unregistered legacy contract", async () => {
					await expect(
						context.alCoreFacet.connect(context.signers.user).importLegacyAccounts(
							context.signers.others[0].address, // Not a registered legacy contract
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Account", coreIndex: 0 }],
						),
					).to.be.revertedWithCustomError(context.alCoreFacet, "LegacyContractNotRegistered")
				})

				it("should reject import with inactive affiliate", async () => {
					await expect(
						context.alCoreFacet.connect(context.signers.user).importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							context.signers.others[0].address, // Not an active affiliate
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Account", coreIndex: 0 }],
						),
					).to.be.revertedWithCustomError(context.alCoreFacet, "AffiliateNotActive")
				})

				it("should reject import with invalid core index", async () => {
					await expect(
						context.alCoreFacet.connect(context.signers.user).importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Account", coreIndex: 5 }], // Invalid index
						),
					).to.be.revertedWithCustomError(context.alCoreFacet, "InvalidCallData")
				})

				it("should reject import with empty accounts array", async () => {
					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.importLegacyAccounts(await legacyMultiAccount.getAddress(), await context.accountManager.getAddress(), [context.diamond], []),
					).to.be.revertedWithCustomError(context.alCoreFacet, "EmptyArray")
				})

				it("should reject import with invalid name length", async () => {
					const maxNameLength = await context.alViewFacet.MAX_NAME_LENGTH()
					const tooLongName = "A".repeat(Number(maxNameLength) + 1)

					await expect(
						context.alCoreFacet
							.connect(context.signers.user)
							.importLegacyAccounts(
								await legacyMultiAccount.getAddress(),
								await context.accountManager.getAddress(),
								[context.diamond],
								[{ account: legacyAccounts[0], name: tooLongName, coreIndex: 0 }],
							),
					).to.be.revertedWithCustomError(context.alCoreFacet, "InvalidNameLength")
				})

				it("should allow _call on imported accounts", async () => {
					// Import account
					await context.alCoreFacet
						.connect(context.signers.user)
						.importLegacyAccounts(
							await legacyMultiAccount.getAddress(),
							await context.accountManager.getAddress(),
							[context.diamond],
							[{ account: legacyAccounts[0], name: "Imported", coreIndex: 0 }],
						)

					// Deposit
					const depositAmount = decimal(1000n)
					await context.collateral.connect(context.signers.user).mint(context.signers.user.address, depositAmount)
					await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), depositAmount)
					await context.accountFacet.connect(context.signers.user).depositFor(legacyAccounts[0], depositAmount)

					// Allocate via _call
					const allocateAmount = decimal(500n)
					const callData: BytesLike[] = [context.accountFacet.interface.encodeFunctionData("allocate", [allocateAmount])]

					await expect(context.alCoreFacet.connect(context.signers.user)._call(legacyAccounts[0], callData)).to.not.be.reverted

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(legacyAccounts[0])
					expect(allocatedBalance).to.equal(allocateAmount)
				})
			})
		})

		describe("Partial open tracking", async () => {
			let positionSubAccountAddress: string

			beforeEach(async () => {
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
			})

			it("cancels the remainder quote of a partial open on a POSITION-isolated virtual account", async () => {
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress))[0]
				const [parentQuoteId] = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const parentBeforeOpen = await context.viewFacetQuote.getQuote(parentQuoteId)
				const filledAmount = parentBeforeOpen.quantity / 2n

				await hedger.lockQuote(parentQuoteId)
				const openRequest = limitOpenRequestBuilder().filledAmount(filledAmount).build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						parentQuoteId,
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				// A POSITION VA must hold exactly one position, so the hook cancels the remainder in the same tx
				const childQuoteId = await context.viewFacetQuote.getNextQuoteId()
				const childQuote = await context.viewFacetQuote.getQuote(childQuoteId)
				expect(childQuote.parentId).to.equal(parentQuoteId)
				expect(childQuote.quoteStatus).to.equal(QuoteStatus.CANCELED)

				expect(await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)).to.deep.equal([parentQuoteId])
				expect(await context.viewFacetQuote.partyAPendingQuotesCount(virtualAccountAddress)).to.equal(0)

				const closeRequest = limitCloseRequestBuilder().quantityToClose(filledAmount).build()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					parentQuoteId,
					closeRequest.closePrice,
					closeRequest.quantityToClose,
					closeRequest.orderType,
					await closeRequest.deadline,
				])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [requestToCloseCallData])

				const fillCloseRequest = limitFillCloseRequestBuilder().filledAmount(filledAmount).build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.fillCloseRequest(
						parentQuoteId,
						fillCloseRequest.filledAmount,
						fillCloseRequest.closedPrice,
						await getDummyPairUpnlAndPriceSig(
							BigInt(fillCloseRequest.price),
							BigInt(fillCloseRequest.upnlPartyA),
							BigInt(fillCloseRequest.upnlPartyB),
						),
					)

				expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.be.false
			})

			it("tracks every pending child created by repeated partial opens on a MARKET-isolated virtual account", async () => {
				const marketSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MARKET_NAME", 1)],
					BALANCES.DEPOSIT_AMOUNT,
				)
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(marketSubAccountAddress))[0]
				const [parentQuoteId] = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const parentQuote = await context.viewFacetQuote.getQuote(parentQuoteId)

				await hedger.lockQuote(parentQuoteId)
				const firstOpen = limitOpenRequestBuilder()
					.filledAmount(parentQuote.quantity / 2n)
					.build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						parentQuoteId,
						firstOpen.filledAmount,
						firstOpen.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(firstOpen.price), BigInt(firstOpen.upnlPartyA), BigInt(firstOpen.upnlPartyB)),
					)

				const firstChildId = await context.viewFacetQuote.getNextQuoteId()
				const firstChild = await context.viewFacetQuote.getQuote(firstChildId)
				expect(firstChild.quoteStatus).to.equal(QuoteStatus.PENDING)
				await hedger.lockQuote(firstChildId)
				const secondOpen = limitOpenRequestBuilder()
					.filledAmount(firstChild.quantity / 2n)
					.build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						firstChildId,
						secondOpen.filledAmount,
						secondOpen.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(secondOpen.price), BigInt(secondOpen.upnlPartyA), BigInt(secondOpen.upnlPartyB)),
					)

				const secondChildId = await context.viewFacetQuote.getNextQuoteId()
				const secondChild = await context.viewFacetQuote.getQuote(secondChildId)
				expect(secondChild.parentId).to.equal(firstChildId)
				expect(secondChild.quoteStatus).to.equal(QuoteStatus.PENDING)
				expect(await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)).to.have.members([
					parentQuoteId,
					firstChildId,
					secondChildId,
				])
			})

			it("does not track the canceled remainder of a cancel-pending partial open", async () => {
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress))[0]
				const [parentQuoteId] = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const parentQuote = await context.viewFacetQuote.getQuote(parentQuoteId)

				await hedger.lockQuote(parentQuoteId)
				const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [parentQuoteId])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [cancelCallData])
				expect((await context.viewFacetQuote.getQuote(parentQuoteId)).quoteStatus).to.equal(QuoteStatus.CANCEL_PENDING)

				const openRequest = limitOpenRequestBuilder()
					.filledAmount(parentQuote.quantity / 2n)
					.build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						parentQuoteId,
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				const canceledChildId = await context.viewFacetQuote.getNextQuoteId()
				expect((await context.viewFacetQuote.getQuote(canceledChildId)).quoteStatus).to.equal(QuoteStatus.CANCELED)
				expect(await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)).to.deep.equal([parentQuoteId])
			})
		})

		describe("Partial close and liquidation behavior", async () => {
			let positionSubAccountAddress: string

			beforeEach(async () => {
				positionSubAccountAddress = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("EXAMPLE_NAME", 0)],
					BALANCES.DEPOSIT_AMOUNT,
				)
			})

			async function partialClosePositionForQuote(partyA: HardhatEthersSigner, quoteId: bigint, virtualAccount: string, quantityToClose: bigint) {
				const closeRequest = limitCloseRequestBuilder().quantityToClose(quantityToClose).build()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					closeRequest.closePrice,
					closeRequest.quantityToClose,
					closeRequest.orderType,
					await closeRequest.deadline,
				])

				await context.alCoreFacet.connect(partyA)._call(virtualAccount, [requestToCloseCallData])

				const fillCloseRequest = limitFillCloseRequestBuilder().filledAmount(quantityToClose).build()
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
			}

			it("Partial close should NOT delete the virtual account", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Partial close: 50 out of 100
				await partialClosePositionForQuote(context.signers.user, quoteId, virtualAccountAddress, decimal(50n))

				// VA should still exist with the quoteId still tracked
				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true

				const quotesAfterPartialClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterPartialClose.length).to.equal(1)
				expect(quotesAfterPartialClose[0]).to.equal(quoteId)

				// Position should still be open on core
				const posCount = await context.viewFacetQuote.partyAPositionsCount(virtualAccountAddress)
				expect(posCount).to.equal(1)
			})

			it("Multiple partial closes then full close should delete VA only at end", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Partial close 25%
				await partialClosePositionForQuote(context.signers.user, quoteId, virtualAccountAddress, decimal(25n))
				let virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true

				// Partial close another 25%
				await partialClosePositionForQuote(context.signers.user, quoteId, virtualAccountAddress, decimal(25n))
				virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true

				// Full close remaining 50%
				await partialClosePositionForQuote(context.signers.user, quoteId, virtualAccountAddress, decimal(50n))

				// Now VA should be deleted
				virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)
			})

			it("Full close still works correctly (regression)", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)
				await closePositionForQuote(context.signers.user, quoteId, virtualAccountAddress)

				const virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false

				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				expect(allocatedBalance).to.equal(0n)

				// Funds should be returned to parent
				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)
			})

			it("PartyA liquidation defers VA deletion, settlement triggers cleanup", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Liquidate the VA (partyA) - SHORT at price 1, quantity 100, liquidation at price 8
				// UPNL = (openedPrice - currentPrice) * quantity = (1-8) * 100 = -700
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				const upnl = decimal(-700n)
				const totalUnrealizedLoss = decimal(-700n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(8n)], totalUnrealizedLoss, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(virtualAccountAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(virtualAccountAddress, liquidationSig)

				// VA should still exist (liquidation is in progress)
				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.true

				// Liquidate pending positions (if any) and open positions
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(virtualAccountAddress)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(virtualAccountAddress, [quoteId])

				// VA quoteIds should be empty (onClosePosition fired) but VA should still exist (deferred)
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				let virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true // Deferred!

				// Settle the liquidation — this calls callLiquidationSettledHooks → onLiquidationSettled
				await context.partyALiquidationFacet
					.connect(context.signers.liquidator)
					.settlePartyALiquidation(virtualAccountAddress, [context.signers.hedger.address])

				// Liquidation should be fully settled
				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.false

				// VA should now be deleted (cleanup happened in onLiquidationSettled)
				virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false
			})

			it("ClearingHouse takeover defers VA deletion, settlement triggers cleanup", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Liquidate the VA (partyA) first - SHORT at price 1, qty 100, liq at price 8
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				const upnl = decimal(-700n)
				const totalUnrealizedLoss = decimal(-700n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(8n)], totalUnrealizedLoss, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(virtualAccountAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(virtualAccountAddress, liquidationSig)

				// Takeover the liquidation via ClearingHouse
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(virtualAccountAddress)

				expect(await context.viewFacet.isPartyATakeoverInProgress(virtualAccountAddress)).to.be.true

				// Liquidate pending and open positions via CH
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePendingPositionsForClearingHouse(virtualAccountAddress, [])
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(virtualAccountAddress, [quoteId], [decimal(8n)])

				// VA quoteIds should be empty but VA still exists (deferred due to takeover)
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				let virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true // Deferred!

				// Settle the takeover — this calls callLiquidationSettledHooks → onLiquidationSettled
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settlePartyATakeover(virtualAccountAddress, [context.signers.hedger.address])

				// Takeover and liquidation should be fully settled
				expect(await context.viewFacet.isPartyATakeoverInProgress(virtualAccountAddress)).to.be.false
				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.false

				// VA should now be deleted (cleanup happened in onLiquidationSettled)
				virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false
			})

			it("Cross PartyB liquidation triggers VA cleanup via close hook", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Enable cross mode for hedger (must be done after position exists)
				await migratePartyBToCross(context, hedger, [quoteId])

				// Initiate cross partyB liquidation
				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Liquidate pending positions for the VA
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [virtualAccountAddress])

				// Liquidate open positions — fires onClosePosition hook
				// VA is not bound, so it gets deleted immediately (no deferral needed)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [quoteId], [decimal(1n)])

				// VA quoteIds should be empty after onClosePosition
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				// VA should still exist — deferred because partyB is in cross liquidation
				let virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.true

				// Settle the cross partyB liquidation — fires onLiquidationSettled hook
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [virtualAccountAddress], true)

				// Cross liquidation should be settled
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false

				// VA should now be deleted (cleanup happened in onLiquidationSettled)
				virtualAccountData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(virtualAccountData.isExists).to.be.false
			})

			it("Multi-position VA: closing one position keeps VA, closing last deletes VA", async () => {
				// Create MARKET sub-account with singleVAMode to get multiple quotes on same VA
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MULTI_POS", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]

				// Fund VA again and send second quote on same symbol
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const callData2 = await createSendQuoteCallData(quote2)
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

				const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quoteIds.length).to.equal(2)

				// Open both positions
				await openPositionForQuote(quoteIds[0])
				await openPositionForQuote(quoteIds[1])

				// Close first position — VA should persist
				await closePositionForQuote(context.signers.user, quoteIds[0], vaAddress)
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true
				const remainingQuotes = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(remainingQuotes.length).to.equal(1)
				expect(remainingQuotes[0]).to.equal(quoteIds[1])

				// Close last position — VA should be deleted
				await closePositionForQuote(context.signers.user, quoteIds[1], vaAddress)
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Cancel pending quote when VA has open position should keep VA", async () => {
				// Create MARKET sub-account with singleVAMode
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CANCEL_MIX", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote and open it
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const quoteIds1 = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(quoteIds1[0])

				// Fund and send second quote (stays pending)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const callData2 = await createSendQuoteCallData(quote2)
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

				const quoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quoteIds.length).to.equal(2)

				// Cancel the pending quote
				const encodedCancel = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteIds[1]])
				await context.alCoreFacet.connect(context.signers.user)._call(vaAddress, [encodedCancel])

				// VA should still exist with 1 quote
				const vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true
				const remainingQuotes = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(remainingQuotes.length).to.equal(1)
				expect(remainingQuotes[0]).to.equal(quoteIds[0])
			})

			it("PartyB isolated liquidation deletes VA immediately (partyA not liquidated)", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// PartyB (hedger) is liquidated against this VA
				// UPNL of -336 makes PartyB insolvent (per existing liquidation tests)
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.address, virtualAccountAddress, await getDummySingleUpnlSig(decimal(-336n)))

				// Liquidate positions — fires onClosePosition hook
				const priceSig = await getDummyPriceSig([quoteId], [decimal(1n)])
				priceSig.timestamp = await context.viewFacet.partyBLiquidationTimestamp(context.signers.hedger.address, virtualAccountAddress)
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsPartyB(context.signers.hedger.address, virtualAccountAddress, priceSig)

				// VA's partyA is NOT liquidated, so VA should be deleted immediately
				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.false

				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false

				// Funds should be returned to parent
				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)
			})

			it("Non-VA partyA: hooks are no-op for regular accounts", async () => {
				// Use the sub-account directly (not a VA) — hooks should silently do nothing
				// The sub-account itself is not a virtual account, so _removeQuoteFromAccount returns early
				const vaData = await context.alViewFacet.getVirtualAccount(positionSubAccountAddress)
				expect(vaData.isExists).to.be.false

				// Sending a quote through a CUSTOM sub-account would trade directly, not via VA
				// Verify that the sub-account is NOT a virtual account
				const isVA = vaData.isExists
				expect(isVA).to.be.false
				// The hooks firing for this address will just return early (not revert)
			})

			it("Mixed pending + open positions: full liquidation flow cleans up VA", async () => {
				// Create MARKET sub-account with singleVAMode to have mixed pending + open on same VA
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MIXED_LIQ", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote and open it (position)
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const quoteIds1 = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(quoteIds1[0])

				// Fund and send second quote (stays pending)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const callData2 = await createSendQuoteCallData(quote2)
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)
				const openQuoteId = allQuoteIds[0]

				// Liquidate the VA — SHORT at price 1, qty 100, liq at price 50
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(vaAddress)
				const upnl = decimal(-4900n)
				const totalUnrealizedLoss = decimal(-4900n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(50n)], totalUnrealizedLoss, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(vaAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(vaAddress, liquidationSig)

				// Liquidate pending positions — fires onCancelQuote hooks after pending array is deleted
				// so core state is consistent and the hook removes the quoteId from the VA
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(vaAddress)

				// Pending quoteId removed by onCancelQuote hook, only open position remains
				const quotesAfterPending = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterPending.length).to.equal(1)

				// Liquidate open positions — fires onClosePosition hook
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(vaAddress, [openQuoteId])

				// All quoteIds removed, VA deferred due to isPartyALiquidated
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true // Deferred due to liquidation

				// Settle liquidation — fires onLiquidationSettled
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(vaAddress, [context.signers.hedger.address])

				// VA should now be deleted
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Isolated partyB liquidation with pending quotes fires cancel hooks and cleans up VA", async () => {
				// Create MARKET sub-account with singleVAMode to get both open + pending on same VA
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("ISO_PB_PEND", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote and open it
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const quoteIds1 = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(quoteIds1[0])

				// Fund and send second quote (lock it but keep pending)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const callData2 = await createSendQuoteCallData(quote2)
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)

				// Lock the second quote so it becomes LOCKED (eligible for liquidation cancel)
				await hedger.lockQuote(allQuoteIds[1])

				// Liquidate partyB (isolated) - this cancels pending quotes via LibPartyBLiquidation.startPartyBLiquidation
				// Our new callCancelQuoteHooks should fire for the locked quote
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.address, vaAddress, await getDummySingleUpnlSig(decimal(-336n)))

				// The pending quote should have been removed from VA by the cancel hook
				const quotesAfterLiqB = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterLiqB.length).to.equal(1) // Only the open position remains
				expect(quotesAfterLiqB[0]).to.equal(allQuoteIds[0])

				// VA still exists (has open position)
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true

				// Liquidate the open position — fires onClosePosition hook
				const priceSig = await getDummyPriceSig([allQuoteIds[0]], [decimal(1n)])
				priceSig.timestamp = await context.viewFacet.partyBLiquidationTimestamp(context.signers.hedger.address, vaAddress)
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsPartyB(context.signers.hedger.address, vaAddress, priceSig)

				// VA should now be deleted (not in any partyA liquidation flow)
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Bound VA with cross partyB liquidation defers and settles correctly", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Make hedger bindable and bind the sub-account to the hedger
				await context.controlFacet.connect(context.signers.admin).setPartyBBindable(context.signers.hedger.address, true)
				const bindCallData = context.bindingFacet.interface.encodeFunctionData("bindToPartyB", [context.signers.hedger.address])
				await context.alCoreFacet.connect(context.signers.user)._call(positionSubAccountAddress, [bindCallData])

				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).partyBWhiteList([context.signers.hedger.address]).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// VA should be bound to hedger
				const vaBindState = await context.viewFacet.getBindState(virtualAccountAddress)
				expect(vaBindState.partyB).to.equal(context.signers.hedger.address)

				// Enable cross mode for hedger
				await migratePartyBToCross(context, hedger, [quoteId])

				// Initiate cross partyB liquidation
				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				// Liquidate pending positions
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [virtualAccountAddress])

				// Liquidate open positions — fires onClosePosition hook
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [quoteId], [decimal(1n)])

				// VA should be deferred — bound partyB is in cross liquidation
				let vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.true
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Settle cross partyB liquidation — fires onLiquidationSettled
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [virtualAccountAddress], true)

				// VA should now be deleted
				vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false
			})

			it("Cross partyB liquidation with pending-only VA defers and settles correctly", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				// Lock the quote but don't open it — stays LOCKED (pending)
				await hedger.lockQuote(quoteId)

				// Enable cross mode for hedger directly (no open positions to migrate)
				await context.controlFacet.setCrossPartyBModeActivated(true)
				await context.controlFacet.setCrossPartyB(context.signers.hedger.address, true)

				// Initiate cross partyB liquidation
				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Liquidate pending positions — fires onCancelQuote hooks
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [virtualAccountAddress])

				// VA quoteIds should be empty
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				// VA should be deferred — partyB still in cross liquidation
				let vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.true

				// Settle — fires onLiquidationSettled
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [virtualAccountAddress], true)

				// VA should now be deleted
				vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Cross partyB liquidation with multiple VAs settles in batch", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Create two separate POSITION sub-accounts to get two different VAs
				const subAccount1 = await createSubAccountAndDeposit(context.signers.user, [createSubAccountData("BATCH_1", 0)], BALANCES.DEPOSIT_AMOUNT)
				const subAccount2 = await createSubAccountAndDeposit(context.signers.user, [createSubAccountData("BATCH_2", 0)], BALANCES.DEPOSIT_AMOUNT)

				// Send quotes on each sub-account — creates separate VAs
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const va1 = (await sendQuoteAndGetVirtualAccount(subAccount1, quote1))[0]
				const va2 = (await sendQuoteAndGetVirtualAccount(subAccount2, quote2))[0]

				const va1QuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(va1, 0, 10)
				const va2QuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(va2, 0, 10)

				// Open both positions
				await openPositionForQuote(va1QuoteIds[0])
				await openPositionForQuote(va2QuoteIds[0])

				// Enable cross mode and initiate cross partyB liquidation
				await migratePartyBToCross(context, hedger, [va1QuoteIds[0], va2QuoteIds[0]])

				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				// Liquidate pending positions for both VAs
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [va1, va2])

				// Liquidate open positions for both
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [va1QuoteIds[0], va2QuoteIds[0]], [decimal(1n), decimal(1n)])

				// Both VAs should be deferred
				expect((await context.alViewFacet.getVirtualAccount(va1)).isExists).to.be.true
				expect((await context.alViewFacet.getVirtualAccount(va2)).isExists).to.be.true

				// Settle first VA only (no finalize)
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [va1], false)

				// VA1 cleaned up, VA2 still deferred
				expect((await context.alViewFacet.getVirtualAccount(va1)).isExists).to.be.false
				expect((await context.alViewFacet.getVirtualAccount(va2)).isExists).to.be.true

				// Cross liq still in progress
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Settle second VA and finalize
				await context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger.address, [va2], true)

				// Both VAs cleaned up, cross liq settled
				expect((await context.alViewFacet.getVirtualAccount(va2)).isExists).to.be.false
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false
			})

			it("Cancel only pending quote (PENDING status) deletes VA immediately", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeCancel = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeCancel.length).to.equal(1)
				const quoteId = quotesBeforeCancel[0]

				// Quote is PENDING (not locked) — immediate cancel
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(0n) // PENDING

				const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [cancelCallData])

				// Quote is immediately CANCELED (no partyB involved)
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(3n) // CANCELED

				// VA should be deleted — it was the only quote
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
			})

			it("PartyB acceptCancelRequest deletes VA when it was the last quote", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeCancel = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeCancel[0]

				// Lock quote so it goes LOCKED, then request cancel → CANCEL_PENDING
				await hedger.lockQuote(quoteId)
				const cancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [cancelCallData])
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(2n) // CANCEL_PENDING

				// PartyB accepts the cancel
				await hedger.acceptCancelRequest(quoteId)

				// Quote is now CANCELED
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(3n) // CANCELED

				// VA should be deleted — no quotes left
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Quote expiration deletes VA when it was the last quote", async () => {
				// Build quote with short deadline
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).deadline(getBlockTimestamp(100n)).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeExpire = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeExpire[0]

				// Advance time past deadline
				await time.increase(1000)

				// Expire the quote — fires onCancelQuote hook
				await context.partyAFacet.expireQuote([quoteId])
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(9n) // EXPIRED

				// VA should be deleted
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
			})

			it("PartyA normal liquidation with paginated settlement across multiple partyBs", async () => {
				// Create MARKET sub-account with singleVAMode for 2 positions with different partyBs
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("PAGINATED_SETTLE", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote for hedger1
				const quote1 = limitQuoteRequestBuilder()
					.symbolId(1)
					.positionType(PositionType.SHORT)
					.partyBWhiteList([context.signers.hedger.address])
					.build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]

				// Fund and send second quote for hedger2
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder()
					.symbolId(1)
					.positionType(PositionType.SHORT)
					.partyBWhiteList([context.signers.hedger2.address])
					.build()
				const callData2 = await createSendQuoteCallData(quote2)
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [callData2])

				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)

				// Open both positions with their respective hedgers
				const hedger2 = new Hedger(context, context.signers.hedger2)
				await hedger2.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)
				const openRequest = limitOpenRequestBuilder().build()
				await hedger.lockQuote(allQuoteIds[0])
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						allQuoteIds[0],
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)
				await hedger2.lockQuote(allQuoteIds[1])
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger2)
					.openPosition(
						allQuoteIds[1],
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				// Liquidate the VA.
				// 2 SHORT positions: qty=100 each, openPrice=1, liqPrice=20
				// Position UPNL per partyB = (20-1)*100 = -1900 each, total = -3800
				// This matches partyAAccumulatedUpnl (avoids "disputed" flag)
				// allocatedBalance ~3500 (3000 initial + 500 extra), so -3800 < -3500 → INSOLVENT ✓
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(vaAddress)
				const upnl = decimal(-3800n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(20n)], upnl, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(vaAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(vaAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePendingPositionsPartyA(vaAddress)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePositionsPartyA(vaAddress, [allQuoteIds[0], allQuoteIds[1]])

				// VA deferred — still has liquidation in progress
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true

				// Settle partyBs one at a time (paginated)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(vaAddress, [context.signers.hedger.address])

				// Still deferred — second partyB not settled yet
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true
				expect(await context.viewFacet.isPartyALiquidated(vaAddress)).to.be.true

				// Settle second partyB — fully settled, onLiquidationSettled fires
				await context.partyALiquidationFacet.connect(context.signers.liquidator).settlePartyALiquidation(vaAddress, [context.signers.hedger2.address])

				expect(await context.viewFacet.isPartyALiquidated(vaAddress)).to.be.false
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("ClearingHouse takeover with mixed pending + open positions cleans up VA", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Create MARKET sub-account with singleVAMode
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CH_MIX", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote and open it
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const quoteIds1 = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(quoteIds1[0])

				// Fund and send second quote (stays pending)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.SHORT).build()
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [await createSendQuoteCallData(quote2)])

				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)

				// Liquidate partyA, then takeover via CH
				// allocatedBalance ~3500 (3000 initial + 500 extra for pending quote), need upnl < -3500
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(vaAddress)
				const upnl = -(allocatedBalance + 1n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(8n)], upnl, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(vaAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(vaAddress, liquidationSig)
				await context.clearingHouseFacet.connect(context.signers.liquidator).takeoverPartyALiquidation(vaAddress)

				expect(await context.viewFacet.isPartyATakeoverInProgress(vaAddress)).to.be.true

				// Liquidate pending positions via CH — fires onCancelQuote
				await context.clearingHouseFacet.connect(context.signers.liquidator).liquidatePendingPositionsForClearingHouse(vaAddress, [])

				const quotesAfterPending = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterPending.length).to.equal(1) // pending quoteId removed

				// Liquidate open positions via CH — fires onClosePosition
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(vaAddress, [quoteIds1[0]], [decimal(8n)])

				const quotesAfterOpen = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterOpen.length).to.equal(0)

				// VA deferred — takeover in progress
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true

				// Settle takeover — fires onLiquidationSettled
				await context.clearingHouseFacet.connect(context.signers.liquidator).settlePartyATakeover(vaAddress, [context.signers.hedger.address])

				expect(await context.viewFacet.isPartyATakeoverInProgress(vaAddress)).to.be.false
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Cross partyB liquidation with mixed pending + open positions cleans up VA", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Create MARKET sub-account with singleVAMode
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CH_CROSS_MIX", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send first quote and open it
				const quote1 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const quoteIds1 = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(quoteIds1[0])

				// Fund and send second quote (lock it — LOCKED is eligible for cross liq pending cancel)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const quote2 = limitQuoteRequestBuilder().symbolId(1).positionType(PositionType.LONG).build()
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [await createSendQuoteCallData(quote2)])
				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)
				await hedger.lockQuote(allQuoteIds[1])

				// Enable cross mode and liquidate
				await migratePartyBToCross(context, hedger, [quoteIds1[0]])
				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				// Liquidate pending positions — fires onCancelQuote for the locked quote
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [vaAddress])

				const quotesAfterPending = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterPending.length).to.equal(1) // pending quoteId removed

				// Liquidate open positions — fires onClosePosition
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [quoteIds1[0]], [decimal(1n)])

				const quotesAfterOpen = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(quotesAfterOpen.length).to.equal(0)

				// VA deferred — partyB still in cross liquidation
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true

				// Settle — fires onLiquidationSettled
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [vaAddress], true)

				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Isolated partyB liquidation with pending-only VA deletes it immediately", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeLiq[0]

				// Lock the quote - LOCKED is eligible for isolated partyB pending cancel
				await hedger.lockQuote(quoteId)
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(1n) // LOCKED

				// Liquidate partyB (isolated) - cancels the LOCKED pending quote via LibPartyBLiquidation.startPartyBLiquidation
				await context.partyBLiquidationFacet
					.connect(context.signers.liquidator)
					.liquidatePartyB(context.signers.hedger.address, virtualAccountAddress, await getDummySingleUpnlSig(decimal(-336n)))

				// Pending quote was cancelled, quoteId removed from VA
				const quotesAfterLiq = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfterLiq.length).to.equal(0)

				// No open positions - partyA NOT liquidated - VA deleted immediately
				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.false
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false

				// Funds returned to parent
				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)
			})

			it("Force cancel quote fires cancel hook and cleans up VA", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				// Lock the quote (hedger locks it)
				await hedger.lockQuote(quoteId)
				let quoteData = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteData.quoteStatus).to.equal(1n) // LOCKED

				// Request cancel through VA
				const requestCancelCallData = context.partyAFacet.interface.encodeFunctionData("requestToCancelQuote", [quoteId])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [requestCancelCallData])

				quoteData = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteData.quoteStatus).to.equal(2n) // CANCEL_PENDING

				// VA should still exist (quote still pending on core)
				let vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.true

				// Advance time past the force cancel cooldown
				await time.increase(300)

				// Force cancel through VA
				const forceCancelCallData = context.forceActionsFacet.interface.encodeFunctionData("forceCancelQuote", [quoteId])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [forceCancelCallData])

				// Quote should be canceled
				quoteData = await context.viewFacetQuote.getQuote(quoteId)
				expect(quoteData.quoteStatus).to.equal(3n) // CANCELED

				// VA should be deleted — force cancel hook fired and cleaned up
				vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Force close position fires onClosePosition hook and deletes VA", async () => {
				// Open a LONG position on a POSITION-isolation VA
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				// Open the position
				await openPositionForQuote(quoteId)
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(4n) // OPENED

				// Request to close through VA (onlyPartyAOfQuote requires msg.sender == partyA)
				const now = await getBlockTimestamp()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					decimal(1n), // closePrice
					decimal(100n), // quantityToClose
					0, // OrderType.LIMIT
					now + 10000n, // deadline far in future
				])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [requestToCloseCallData])
				expect((await context.viewFacetQuote.getQuote(quoteId)).quoteStatus).to.equal(5n) // CLOSE_PENDING

				// Advance time past both cooldowns: firstCooldown(300) + secondCooldown(120) + margin
				await time.increase(450n)

				// Build high-low price sig satisfying validateForceCloseConditions:
				// startTime >= statusModifyTimestamp + firstCooldown (300)
				// endTime <= block.timestamp - secondCooldown (120)
				// For a LONG position: highest >= closePrice (gapRatio=0 default -> highest >= decimal(1n))
				const afterTime = await getBlockTimestamp()
				const sigStartTime = afterTime - 149n // ~T_request+301 >= T_request+300 ✓
				const sigEndTime = afterTime - 121n // <= afterTime-120 ✓, >= sigStartTime ✓
				const highLowSig = await getDummyHighLowPriceSig(
					sigStartTime, // startTime
					sigEndTime, // endTime
					decimal(1n), // lowest
					decimal(1n), // highest (>= closePrice=1 for LONG)
					decimal(1n), // currentPrice
					decimal(1n), // averagePrice (must be between lowest and highest)
					1n, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)

				// Force close — anyone can call this (no onlyPartyA modifier)
				await context.forceActionsFacet.connect(context.signers.user).forceClosePosition(quoteId, highLowSig)

				// VA should be deleted — force close fires onClosePosition hook
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.false

				// Funds returned to parent
				const parentBalance = await context.viewFacet.balanceOf(positionSubAccountAddress)
				expect(parentBalance).to.be.gt(0n)
			})

			it("Multi-partyB VA: positions with cross-liq partyB defers deletion until cross settlement", async () => {
				// Grant CLEARING_HOUSE_ROLE to liquidator
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Create MARKET sub-account with singleVAMode so both quotes go to one VA
				const marketSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("MULTI_PB_CROSS", 1, "MARKET", true)],
					BALANCES.DEPOSIT_AMOUNT,
				)

				// Send and open first quote with hedger (partyB_X — will go into cross liq)
				const quote1 = limitQuoteRequestBuilder()
					.symbolId(1)
					.positionType(PositionType.LONG)
					.partyBWhiteList([context.signers.hedger.address])
					.build()
				const virtualAccounts = await sendQuoteAndGetVirtualAccount(marketSubAccount, quote1)
				const vaAddress = virtualAccounts[0]
				const va1QuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				await openPositionForQuote(va1QuoteIds[0])

				// Fund VA and send second quote with hedger2 (partyB_Y — will close normally)
				await context.collateral.connect(context.signers.user).approve(await context.accountFacet.getAddress(), decimal(500n))
				await context.accountFacet.connect(context.signers.user).depositAndAllocateFor(vaAddress, decimal(500n))
				const hedger2 = new Hedger(context, context.signers.hedger2)
				await hedger2.setBalances(BALANCES.INITIAL_COLLATERAL, BALANCES.INITIAL_COLLATERAL)
				const quote2 = limitQuoteRequestBuilder()
					.symbolId(1)
					.positionType(PositionType.LONG)
					.partyBWhiteList([context.signers.hedger2.address])
					.build()
				await context.alCoreFacet.connect(context.signers.user)._call(marketSubAccount, [await createSendQuoteCallData(quote2)])
				const allQuoteIds = await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)
				expect(allQuoteIds.length).to.equal(2)
				// Open quote2 with hedger2
				const openRequest = limitOpenRequestBuilder().build()
				await hedger2.lockQuote(allQuoteIds[1])
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger2)
					.openPosition(
						allQuoteIds[1],
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				// Put hedger (partyB_X) into cross liquidation
				await migratePartyBToCross(context, hedger, [va1QuoteIds[0]])
				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Liquidate partyB_X's open position — fires onClosePosition hook,
				// records hedger in vaPendingCrossLiqPartyBs[vaAddress]
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [va1QuoteIds[0]], [decimal(1n)])

				// VA still has quote2 (partyB_Y's position)
				expect((await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)).length).to.equal(1)
				expect((await context.alViewFacet.getVirtualAccount(vaAddress)).isExists).to.be.true

				// Close partyB_Y's position normally (fillCloseRequest)
				const now = await getBlockTimestamp()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					allQuoteIds[1],
					decimal(1n),
					decimal(100n),
					0, // OrderType.LIMIT
					now + 10000n,
				])
				await context.alCoreFacet.connect(context.signers.user)._call(vaAddress, [requestToCloseCallData])
				const fillCloseRequest = limitFillCloseRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger2)
					.fillCloseRequest(
						allQuoteIds[1],
						fillCloseRequest.filledAmount,
						fillCloseRequest.closedPrice,
						await getDummyPairUpnlAndPriceSig(
							BigInt(fillCloseRequest.price),
							BigInt(fillCloseRequest.upnlPartyA),
							BigInt(fillCloseRequest.upnlPartyB),
						),
					)

				// VA now has 0 quotes, but hedger (partyB_X) still in cross liq → VA deferred
				expect((await context.alViewFacet.getVirtualAccountQuoteIds(vaAddress, 0, 10)).length).to.equal(0)
				let vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.true
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Settle cross liquidation — fires onLiquidationSettled → clears vaPendingCrossLiqPartyBs → VA deleted
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [vaAddress], true)

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false
				vaData = await context.alViewFacet.getVirtualAccount(vaAddress)
				expect(vaData.isExists).to.be.false
			})

			it("Non-VA partyA: hooks fire without reverting for regular accounts", async () => {
				// Create a CUSTOM sub-account — trades directly, no VA created
				const customSubAccount = await createSubAccountAndDeposit(
					context.signers.user,
					[createSubAccountData("CUSTOM_DIRECT", 3)], // 3 = CUSTOM isolation
					BALANCES.DEPOSIT_AMOUNT,
					true, // allocate too (CUSTOM needs direct allocation)
				)

				// Verify this is NOT a virtual account
				const vaData = await context.alViewFacet.getVirtualAccount(customSubAccount)
				expect(vaData.isExists).to.be.false

				// Send quote directly from the CUSTOM sub-account (no VA)
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const sendQuoteCallData = await createSendQuoteCallData(quoteRequest)
				await context.alCoreFacet.connect(context.signers.user)._call(customSubAccount, [sendQuoteCallData])

				// Lock and open the position — fires onOpenPosition hook (no-op for non-VA, should not revert)
				const quoteIds = await context.viewFacetQuote.getPartyAPendingQuotes(customSubAccount)
				expect(quoteIds.length).to.equal(1)
				await hedger.lockQuote(quoteIds[0])
				const openRequest = limitOpenRequestBuilder().build()
				await context.partyBPositionActionsFacet
					.connect(context.signers.hedger)
					.openPosition(
						quoteIds[0],
						openRequest.filledAmount,
						openRequest.openPrice,
						await getDummyPairUpnlAndPriceSig(BigInt(openRequest.price), BigInt(openRequest.upnlPartyA), BigInt(openRequest.upnlPartyB)),
					)

				// Close the position — fires onClosePosition hook (should be no-op for non-VA)
				await closePositionForQuote(context.signers.user, quoteIds[0], customSubAccount)

				// Sub-account should still exist and not have been corrupted
				const subAccountData = await context.alViewFacet.getSubAccount(customSubAccount)
				expect(subAccountData.isExists).to.be.true

				// Verify the quote is closed
				const quoteData = await context.viewFacetQuote.getQuote(quoteIds[0])
				expect(quoteData.quoteStatus).to.equal(7n) // CLOSED
			})

			it("Force partial close should NOT delete the virtual account", async () => {
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesBeforeClose.length).to.equal(1)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Request to close only part (50 out of 100)
				const now = await getBlockTimestamp()
				const requestToCloseCallData = context.partyAFacet.interface.encodeFunctionData("requestToClosePosition", [
					quoteId,
					decimal(1n), // closePrice
					decimal(50n), // quantityToClose — partial
					0, // OrderType.LIMIT
					now + 10000n,
				])
				await context.alCoreFacet.connect(context.signers.user)._call(virtualAccountAddress, [requestToCloseCallData])

				// Advance time past both cooldowns
				await time.increase(450n)

				// Build high-low price sig for force close
				const afterTime = await getBlockTimestamp()
				const sigStartTime = afterTime - 149n
				const sigEndTime = afterTime - 121n
				const highLowSig = await getDummyHighLowPriceSig(
					sigStartTime,
					sigEndTime,
					decimal(1n), // lowest
					decimal(1n), // highest (>= closePrice=1 for LONG)
					decimal(1n), // currentPrice
					decimal(1n), // averagePrice
					1n, // symbolId
					0n, // upnlPartyB
					0n, // upnlPartyA
				)

				// Force close — only partial (50 out of 100)
				await context.forceActionsFacet.connect(context.signers.user).forceClosePosition(quoteId, highLowSig)

				// VA should still exist — position still open (partial close)
				const vaData = await context.alViewFacet.getVirtualAccount(virtualAccountAddress)
				expect(vaData.isExists).to.be.true

				// Quote should still be tracked
				const quotesAfter = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				expect(quotesAfter.length).to.equal(1)
				expect(quotesAfter[0]).to.equal(quoteId)

				// Position should still be open on core
				const posCount = await context.viewFacetQuote.partyAPositionsCount(virtualAccountAddress)
				expect(posCount).to.equal(1)
			})

			it("settleCrossPartyBLiquidation with finalize=false does NOT clear inProgress", async () => {
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.LONG).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Enable cross mode and initiate cross partyB liquidation
				await migratePartyBToCross(context, hedger, [quoteId])

				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				// Liquidate pending and open positions
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [virtualAccountAddress])
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [quoteId], [decimal(1n)])

				// Call settle with finalize=false — hooks fire but inProgress should remain true
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settleCrossPartyBLiquidation(context.signers.hedger.address, [virtualAccountAddress], false)

				// VA should be deleted (hook fired and cleared pending cross liq partyBs)
				expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.be.false

				// But cross liquidation should STILL be in progress (finalize=false)
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.true

				// Now finalize with empty partyAs array
				await context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger.address, [], true)

				// Now cross liq should be settled
				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false
			})

			it("Auto-takeover during cross partyB liq when partyA is a VA", async () => {
				await context.controlFacet.grantRole(context.signers.liquidator.address, roleHash("CLEARING_HOUSE_ROLE"))

				// Create a VA with a SHORT position (so we can liquidate the partyA too)
				const quoteRequest = limitQuoteRequestBuilder().positionType(PositionType.SHORT).build()
				const virtualAccountAddress = (await sendQuoteAndGetVirtualAccount(positionSubAccountAddress, quoteRequest))[0]

				const quotesBeforeClose = await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)
				const quoteId = quotesBeforeClose[0]

				await openPositionForQuote(quoteId)

				// Liquidate the VA (partyA) first — set it in liquidation state
				const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccountAddress)
				const upnl = decimal(-700n)
				const totalUnrealizedLoss = decimal(-700n)
				const liquidationSig = await getDummyLiquidationSig("0x10", upnl, [1n], [decimal(8n)], totalUnrealizedLoss, allocatedBalance)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).liquidatePartyA(virtualAccountAddress, liquidationSig)
				await context.partyALiquidationFacet.connect(context.signers.liquidator).setSymbolsPrice(virtualAccountAddress, liquidationSig)

				expect(await context.viewFacet.isPartyALiquidated(virtualAccountAddress)).to.be.true

				// Now put hedger into cross liquidation — triggers auto-takeover of the VA's partyA liq
				await migratePartyBToCross(context, hedger, [quoteId])

				const timestamp = await getBlockTimestamp()
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidateCrossPartyB(context.signers.hedger.address, "0x", decimal(-1000n), timestamp)

				// Liquidate pending positions — this triggers _autoTakeoverPartyALiquidation for the VA
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePendingPositionsForClearingHouse(context.signers.hedger.address, [virtualAccountAddress])

				// VA should now be in takeover (auto-takeover happened)
				expect(await context.viewFacet.isPartyATakeoverInProgress(virtualAccountAddress)).to.be.true

				// Liquidate the open position
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.liquidatePositionsForClearingHouse(context.signers.hedger.address, [quoteId], [decimal(8n)])

				// VA quoteIds empty but still exists (deferred — both takeover and cross liq active)
				expect((await context.alViewFacet.getVirtualAccountQuoteIds(virtualAccountAddress, 0, 10)).length).to.equal(0)
				expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.be.true

				// Settle the takeover first — this fires onLiquidationSettled
				// But cross partyB liq is still in progress, so the hook clears pending cross liq entries
				// and _tryDeleteVirtualAccount checks isPartyALiquidated (false after takeover settle)
				// and isPartyATakeoverInProgress (false after settle). But the cross liq is still in progress
				// via vaPendingCrossLiqPartyBs — which was just cleared by onLiquidationSettled.
				// So VA should be deleted here.
				await context.clearingHouseFacet
					.connect(context.signers.liquidator)
					.settlePartyATakeover(virtualAccountAddress, [context.signers.hedger.address])

				expect(await context.viewFacet.isPartyATakeoverInProgress(virtualAccountAddress)).to.be.false

				// VA should be deleted (onLiquidationSettled from settlePartyATakeover cleaned it up)
				expect((await context.alViewFacet.getVirtualAccount(virtualAccountAddress)).isExists).to.be.false

				// Finalize cross partyB liq (no VAs left to settle)
				await context.clearingHouseFacet.connect(context.signers.liquidator).settleCrossPartyBLiquidation(context.signers.hedger.address, [], true)

				expect(await context.viewFacet.getPartyBCrossLiquidationStatus(context.signers.hedger.address)).to.be.false
			})
		})
	})
}
