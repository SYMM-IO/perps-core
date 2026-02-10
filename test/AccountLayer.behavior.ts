import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers"
import { expect } from "chai"
import { BytesLike, toUtf8Bytes, ZeroAddress } from "ethers"

import { IAccountHubHook__factory, ISymmioHook__factory } from "../src/types/index.js"
import type { MockAccountHubHook } from "../src/types/index.js"
import { initializeFixture } from "./Initialize.fixture.js"
import { ethers } from "./helpers/hardhat-connection.js"
import { loadFixture, time } from "./helpers/network-helpers.js"
import { PositionType } from "./models/Enums.js"
import { Hedger } from "./models/Hedger.js"
import { RunContext } from "./models/RunContext.js"
import { User } from "./models/User.js"
import { limitCloseRequestBuilder } from "./models/requestModels/CloseRequest.js"
import { limitFillCloseRequestBuilder } from "./models/requestModels/FillCloseRequest.js"
import { limitOpenRequestBuilder } from "./models/requestModels/OpenRequest.js"
import { limitQuoteRequestBuilder } from "./models/requestModels/QuoteRequest.js"
import { decimal } from "./utils/Common.js"
import { getDummyPairUpnlAndPriceSig, getDummySingleUpnlSig } from "./utils/SignatureUtils.js"

// SubAccountCreationData struct type for AccountLayer
type SubAccountCreationDataStruct = {
	name: string
	metadata: BytesLike
	symmioCore: string
	isolationType: number
	singleVAMode: boolean
}

const roleHash = (name: string) => ethers.keccak256(toUtf8Bytes(name))

export function shouldBehaveLikeAccountLayer(): void {
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

		describe("express deposit", function () {
			let subAccountAddress: string
			let virtualProviderAddress: string
			const expressRate = decimal(3n, 16) // 3%
			const depositAmount = decimal(1000n)

			const registerVirtualProvider = async () => {
				const MockVirtualProvider = await ethers.getContractFactory("contracts/core/test/MockVirtualProvider.sol:VirtualProvider")
				const virtualProvider = await MockVirtualProvider.deploy(context.diamond)
				virtualProviderAddress = await virtualProvider.getAddress()
				await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(virtualProviderAddress)
				return virtualProvider
			}

			const setExpressConfig = async (rate: bigint, provider: string) => {
				await context.alAffiliateFacet.connect(context.signers.admin).setExpressRate(await context.accountManager.getAddress(), rate)
				await context.alAffiliateFacet.connect(context.signers.admin).setVirtualProvider(await context.accountManager.getAddress(), provider)
			}

			const approveExpressDeposit = async (amount: bigint) => {
				await context.collateral.connect(context.signers.user).approve(context.accountLayerDiamond, amount)
				await context.collateral.connect(context.signers.user).approve(context.diamond, amount)
			}

			beforeEach(async function () {
				subAccountAddress = await createSubAccount(context.signers.user, [createSubAccountData("EXPRESS_ACCOUNT", 3, "EXPRESS")])
			})

			it("splits deposit between real and virtual amounts", async function () {
				const provider = await registerVirtualProvider()
				await setExpressConfig(expressRate, virtualProviderAddress)
				await approveExpressDeposit(depositAmount)

				const virtualAmount = (depositAmount * expressRate) / decimal(1n)
				const realAmount = depositAmount - virtualAmount

				const userAddress = context.signers.user.address
				const userBalanceBefore = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceBefore = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceBefore = await context.collateral.balanceOf(context.diamond)

				await context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount)

				const userBalanceAfter = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceAfter = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceAfter = await context.collateral.balanceOf(context.diamond)
				const providerBalance = await context.collateral.balanceOf(virtualProviderAddress)

				expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount)
				expect(accountLayerBalanceAfter - accountLayerBalanceBefore).to.equal(0n)
				expect(balanceAfter - balanceBefore).to.equal(depositAmount)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(realAmount)
				expect(providerBalance).to.equal(virtualAmount)
			})

			it("reverts when virtual provider is not registered on Symmio", async function () {
				const MockVirtualProvider = await ethers.getContractFactory("contracts/core/test/MockVirtualProvider.sol:VirtualProvider")
				const virtualProvider = await MockVirtualProvider.deploy(context.diamond)
				virtualProviderAddress = await virtualProvider.getAddress()

				await setExpressConfig(expressRate, virtualProviderAddress)
				await approveExpressDeposit(depositAmount)

				await expect(
					context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
				).to.be.revertedWith("AccountFacet : msg.sender not registered as virtual provider")
			})

			it("reverts when express rate is set without virtual provider", async function () {
				await context.alAffiliateFacet.connect(context.signers.admin).setExpressRate(await context.accountManager.getAddress(), expressRate)
				await approveExpressDeposit(depositAmount)

				await expect(
					context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
				).to.be.revertedWithCustomError(context.alCoreFacet, "VirtualProviderRequired")
			})

			it("reverts when amount is zero", async function () {
				await registerVirtualProvider()
				await setExpressConfig(expressRate, virtualProviderAddress)

				await expect(
					context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, 0n),
				).to.be.revertedWithCustomError(context.alCoreFacet, "ZeroAmount")
			})

			it("reverts when express rate exceeds 100% (at setter level)", async function () {
				await registerVirtualProvider()
				const invalidExpressRate = decimal(1n) + 1n // 100% + 1 wei

				// Express rate validation happens at the setter level (setExpressRate)
				await expect(
					context.alAffiliateFacet.connect(context.signers.admin).setExpressRate(await context.accountManager.getAddress(), invalidExpressRate),
				).to.be.revertedWithCustomError(context.alAffiliateFacet, "InvalidShare")
			})

			it("handles zero express rate without virtual transfer", async function () {
				await context.alAffiliateFacet.connect(context.signers.admin).setExpressRate(await context.accountManager.getAddress(), 0)
				await approveExpressDeposit(depositAmount)

				const userAddress = context.signers.user.address
				const userBalanceBefore = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceBefore = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceBefore = await context.collateral.balanceOf(context.diamond)

				await context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount)

				const userBalanceAfter = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceAfter = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceAfter = await context.collateral.balanceOf(context.diamond)
				expect(balanceAfter - balanceBefore).to.equal(depositAmount)
				expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount)
				expect(accountLayerBalanceAfter - accountLayerBalanceBefore).to.equal(0n)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(depositAmount)
			})

			it("handles full express rate by crediting only virtual balance", async function () {
				await registerVirtualProvider()
				await setExpressConfig(decimal(1n), virtualProviderAddress)
				await approveExpressDeposit(depositAmount)

				const userAddress = context.signers.user.address
				const userBalanceBefore = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceBefore = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceBefore = await context.collateral.balanceOf(context.diamond)

				await context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount)

				const userBalanceAfter = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceAfter = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
				const coreBalanceAfter = await context.collateral.balanceOf(context.diamond)
				const providerBalance = await context.collateral.balanceOf(virtualProviderAddress)

				expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount)
				expect(accountLayerBalanceAfter - accountLayerBalanceBefore).to.equal(0n)
				expect(balanceAfter - balanceBefore).to.equal(depositAmount)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(0n)
				expect(providerBalance).to.equal(depositAmount)
			})

			it("allocates the real portion when using depositAndAllocate", async function () {
				await registerVirtualProvider()
				await setExpressConfig(expressRate, virtualProviderAddress)
				await approveExpressDeposit(depositAmount)

				const virtualAmount = (depositAmount * expressRate) / decimal(1n)
				const realAmount = depositAmount - virtualAmount

				const userAddress = context.signers.user.address
				const userBalanceBefore = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceBefore = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceBefore = await context.viewFacet.balanceOf(subAccountAddress)
				const allocatedBefore = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
				const coreBalanceBefore = await context.collateral.balanceOf(context.diamond)

				await context.alCoreFacet.connect(context.signers.user).depositAndAllocateForAccountWithExpressRate(subAccountAddress, depositAmount)

				const userBalanceAfter = await context.collateral.balanceOf(userAddress)
				const accountLayerBalanceAfter = await context.collateral.balanceOf(context.accountLayerDiamond)
				const balanceAfter = await context.viewFacet.balanceOf(subAccountAddress)
				const allocatedAfter = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
				const coreBalanceAfter = await context.collateral.balanceOf(context.diamond)

				expect(userBalanceBefore - userBalanceAfter).to.equal(depositAmount)
				expect(accountLayerBalanceAfter - accountLayerBalanceBefore).to.equal(0n)
				expect(balanceAfter - balanceBefore).to.equal(virtualAmount)
				expect(allocatedAfter - allocatedBefore).to.equal(realAmount)
				expect(coreBalanceAfter - coreBalanceBefore).to.equal(realAmount)
			})

			it("requires the account owner", async function () {
				await registerVirtualProvider()
				await setExpressConfig(expressRate, virtualProviderAddress)
				await approveExpressDeposit(depositAmount)

				await expect(
					context.alCoreFacet.connect(context.signers.others[0]).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
				).to.be.revertedWithCustomError(context.alCoreFacet, "NotOwner")
			})

			describe("onExpressDeposit callback failures", function () {
				let configurableMockProvider: any
				let configurableMockProviderAddress: string

				const registerConfigurableMockProvider = async () => {
					const ConfigurableMockVirtualProvider = await ethers.getContractFactory(
						"contracts/core/test/MockVirtualProvider.sol:ConfigurableMockVirtualProvider",
					)
					configurableMockProvider = await ConfigurableMockVirtualProvider.deploy()
					configurableMockProviderAddress = await configurableMockProvider.getAddress()
					await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(configurableMockProviderAddress)
					return configurableMockProvider
				}

				it("reverts when onExpressDeposit callback reverts", async function () {
					await registerConfigurableMockProvider()
					await configurableMockProvider.setFailureMode(1) // REVERT mode
					await setExpressConfig(expressRate, configurableMockProviderAddress)
					await approveExpressDeposit(depositAmount)

					await expect(
						context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
					).to.be.revertedWith("ConfigurableMockVirtualProvider: intentional revert")
				})

				it("reverts when onExpressDeposit credits wrong amount (less)", async function () {
					await registerConfigurableMockProvider()
					await configurableMockProvider.setFailureMode(2) // WRONG_AMOUNT mode
					await configurableMockProvider.setAmountDelta(-1n) // Credit 1 less
					await setExpressConfig(expressRate, configurableMockProviderAddress)
					await approveExpressDeposit(depositAmount)

					await expect(
						context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
					).to.be.revertedWithCustomError(context.alCoreFacet, "BalanceInvariantViolation")
				})

				it("reverts when onExpressDeposit credits wrong amount (more)", async function () {
					await registerConfigurableMockProvider()
					await configurableMockProvider.setFailureMode(2) // WRONG_AMOUNT mode
					await configurableMockProvider.setAmountDelta(1n) // Credit 1 more
					await setExpressConfig(expressRate, configurableMockProviderAddress)
					await approveExpressDeposit(depositAmount)

					await expect(
						context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
					).to.be.revertedWithCustomError(context.alCoreFacet, "BalanceInvariantViolation")
				})

				it("reverts when onExpressDeposit credits wrong user", async function () {
					await registerConfigurableMockProvider()
					await configurableMockProvider.setFailureMode(3) // WRONG_USER mode
					await configurableMockProvider.setWrongUser(context.signers.others[0].address)
					await setExpressConfig(expressRate, configurableMockProviderAddress)
					await approveExpressDeposit(depositAmount)

					await expect(
						context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount),
					).to.be.revertedWithCustomError(context.alCoreFacet, "BalanceInvariantViolation")
				})

				it("prevents malicious provider from impersonating user via callback (SafeCall protection)", async function () {
					// Deploy malicious provider that attempts to exploit the callback
					const MaliciousMockVirtualProvider = await ethers.getContractFactory(
						"contracts/core/test/MockVirtualProvider.sol:MaliciousMockVirtualProvider",
					)
					const maliciousProvider = await MaliciousMockVirtualProvider.deploy(context.accountLayerDiamond)
					const maliciousProviderAddress = await maliciousProvider.getAddress()

					// Register the malicious provider
					await context.controlFacet.connect(context.signers.admin).registerVirtualProvider(maliciousProviderAddress)
					await setExpressConfig(expressRate, maliciousProviderAddress)
					await approveExpressDeposit(depositAmount)

					// Execute the deposit - the malicious provider will attempt to impersonate the user
					await context.alCoreFacet.connect(context.signers.user).depositForAccountWithExpressRate(subAccountAddress, depositAmount)

					// Verify the attack was attempted
					expect(await maliciousProvider.attackAttempted()).to.be.true

					// Verify the attack failed (signer was cleared, so callback couldn't impersonate user)
					expect(await maliciousProvider.attackSucceeded()).to.be.false

					// Verify that getSigner() returned the malicious provider's address (msg.sender)
					// instead of the original user, proving the signer was properly cleared
					const capturedSigner = await maliciousProvider.capturedSigner()
					expect(capturedSigner).to.equal(maliciousProviderAddress)
					expect(capturedSigner).to.not.equal(context.signers.user.address)
				})
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

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.be.greaterThan(0)

					await context.alCoreFacet
						.connect(context.signers.user)
						._call(subAccountAddress, [
							context.accountFacet.interface.encodeFunctionData("deallocate", [allocatedBalance, await getDummySingleUpnlSig(BigInt(1e30))]),
						])
					await time.increase((await context.viewFacet.getDeallocateDebounceTime()) + 1n)

					await context.alCoreFacet
						.connect(context.signers.user)
						._call(subAccountAddress, [context.accountFacet.interface.encodeFunctionData("withdraw", [allocatedBalance])])

					const allocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalanceAfter).to.equal(0)

					const balance = await context.viewFacet.balanceOf(subAccountAddress)
					expect(balance).to.equal(0)

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

					const allocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalance).to.be.greaterThan(0)

					await context.alCoreFacet
						.connect(context.signers.user)
						._call(subAccountAddress, [
							context.accountFacet.interface.encodeFunctionData("deallocate", [allocatedBalance, await getDummySingleUpnlSig(BigInt(1e30))]),
						])
					await time.increase((await context.viewFacet.getDeallocateDebounceTime()) + 1n)

					await context.alCoreFacet
						.connect(context.signers.user)
						._call(subAccountAddress, [context.accountFacet.interface.encodeFunctionData("withdraw", [allocatedBalance])])

					const allocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(subAccountAddress)
					expect(allocatedBalanceAfter).to.equal(0)

					const balance = await context.viewFacet.balanceOf(subAccountAddress)
					expect(balance).to.equal(0)

					await expect(context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)).to.be.revertedWithCustomError(
						context.alCoreFacet,
						"OpenPositionsExist",
					)
				})
			})

			describe("hook integration", async () => {
				let mockHook: MockAccountHubHook

				beforeEach(async () => {
					// Deploy mock hook
					const MockAccountHubHook = await ethers.getContractFactory("MockAccountHubHook")
					mockHook = await MockAccountHubHook.deploy()
					await mockHook.waitForDeployment()

					// Register the hook for onSubAccountDeletion
					const affiliateAddress = await context.accountManager.getAddress()
					const onSubAccountDeletionSelector = IAccountHubHook__factory.createInterface().getFunction("onSubAccountDeletion").selector
					await context.alAffiliateFacet.setHook(affiliateAddress, onSubAccountDeletionSelector, await mockHook.getAddress())
				})

				it("should call affiliate hook on deletion", async () => {
					const subAccountData = [createSubAccountData("HOOK_TEST", 0, "TEST")]
					const subAccountAddress = await createSubAccount(context.signers.user, subAccountData)

					// Delete the sub-account
					await context.alCoreFacet.connect(context.signers.user).deleteSubAccount(subAccountAddress)

					// Verify hook was called
					const onSubAccountDeletionSelector = IAccountHubHook__factory.createInterface().getFunction("onSubAccountDeletion").selector
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
			let hookContract: MockAccountHubHook
			let subAccountAddress: string
			let customSubAccountAddress: string
			let hookEvents: any

			const HOOK_SELECTORS = {
				onAccountCreation: IAccountHubHook__factory.createInterface().getFunction("onAccountCreation").selector,
				onVirtualAccountCreation: IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountCreation").selector,
				onVirtualAccountDeletion: IAccountHubHook__factory.createInterface().getFunction("onVirtualAccountDeletion").selector,
			}
			const SYMMIO_HOOK_SELECTORS = {
				onCancelQuote: ISymmioHook__factory.createInterface().getFunction("onCancelQuote").selector,
			}

			beforeEach(async () => {
				// Deploy mock hook contract
				const MockHook = await ethers.getContractFactory("MockAccountHubHook")
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

			describe("executeForAccount hook callback", async () => {
				beforeEach(async () => {
					// Set the AccountHub address in the mock hook
					await hookContract.setAccountHub(context.accountLayerDiamond)

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
					const MaliciousHook = await ethers.getContractFactory("MaliciousAccountHubHook")
					maliciousHook = await MaliciousHook.deploy()
					await maliciousHook.waitForDeployment()

					// Set the AccountHub address in the malicious hook
					await maliciousHook.setAccountHub(context.accountLayerDiamond)
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
					const subAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					const virtualAccountAllocatedBalanceBefore = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)

					// Virtual account should have balance from the deposit
					expect(virtualAccountAllocatedBalanceBefore).to.equal(BALANCES.TRANSFER_AMOUNT)

					// Transfer from virtual account to subaccount
					await expect(
						context.alMarginFacet.connect(context.signers.user).removeMargin(virtualAccount, BALANCES.TRANSFER_AMOUNT, await getDummySingleUpnlSig()),
					)
						.to.emit(context.alMarginFacet, "RemoveMargin")
						.withArgs(virtualAccount, customSubAccount, BALANCES.TRANSFER_AMOUNT)

					// Check balances after transfer
					const virtualAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(virtualAccount)
					expect(virtualAccountAllocatedBalanceAfter).to.equal(0)

					const subAccountAllocatedBalanceAfter = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)
					expect(subAccountAllocatedBalanceAfter).to.equal(subAccountAllocatedBalanceBefore + BALANCES.TRANSFER_AMOUNT)
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
					const subAccountAllocatedBalance = await context.viewFacet.allocatedBalanceOfPartyA(customSubAccount)

					expect(virtualAccountAllocatedBalance).to.equal(0)
					expect(subAccountAllocatedBalance).to.equal(BALANCES.TRANSFER_AMOUNT)
				})
			})
		})

		describe("Legacy Account Migration", async () => {
			let legacyMultiAccount: any
			let legacyAccounts: string[]

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
	})
}
