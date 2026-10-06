import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types"
import { expect } from "chai"
import { keccak256, parseEther, toUtf8Bytes } from "ethers"

import { ethers } from "./helpers/hardhat-connection.js"
import { time } from "./helpers/network-helpers.js"

const SYMBOL_ADDER_ROLE = keccak256(toUtf8Bytes("SYMBOL_ADDER_ROLE"))
const SYMBOL_REMOVER_ROLE = keccak256(toUtf8Bytes("SYMBOL_REMOVER_ROLE"))
const SYMBOL_TRADING_FEE_MANAGER_ROLE = keccak256(toUtf8Bytes("SYMBOL_TRADING_FEE_MANAGER_ROLE"))
const SYMBOL_MAX_LEVERAGE_MANAGER_ROLE = keccak256(toUtf8Bytes("SYMBOL_MAX_LEVERAGE_MANAGER_ROLE"))
const SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE = keccak256(toUtf8Bytes("SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE"))
const SYMBOL_FUNDING_STATE_MANAGER_ROLE = keccak256(toUtf8Bytes("SYMBOL_FUNDING_STATE_MANAGER_ROLE"))
const SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE = keccak256(toUtf8Bytes("SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE"))
const SETTER_ROLE = keccak256(toUtf8Bytes("SETTER_ROLE"))
const PAUSER_ROLE = keccak256(toUtf8Bytes("PAUSER_ROLE"))
const UNPAUSER_ROLE = keccak256(toUtf8Bytes("UNPAUSER_ROLE"))

type Symbol = {
	symbolId: number
	name: string
	isValid: boolean
	minAcceptableQuoteValue: bigint
	minAcceptablePortionLF: bigint
	tradingFee: bigint
	maxLeverage: bigint
	fundingRateEpochDuration: number
	fundingRateWindowTime: number
}

type SymbolWithType = Symbol & { symbolType: number }

function getDefaultSymbols(): Symbol[] {
	return [
		{
			symbolId: 1,
			name: "BTCUSDT",
			isValid: true,
			minAcceptableQuoteValue: parseEther("100"),
			minAcceptablePortionLF: parseEther("0.1"),
			tradingFee: parseEther("0.01"),
			maxLeverage: parseEther("10"),
			fundingRateEpochDuration: 86400,
			fundingRateWindowTime: 3600,
		},
		{
			symbolId: 2,
			name: "ETHUSDT",
			isValid: true,
			minAcceptableQuoteValue: parseEther("200"),
			minAcceptablePortionLF: parseEther("0.05"),
			tradingFee: parseEther("0.015"),
			maxLeverage: parseEther("15"),
			fundingRateEpochDuration: 86400,
			fundingRateWindowTime: 3600,
		},
	]
}

function getExtraSymbols(): Symbol[] {
	return [
		{
			symbolId: 3,
			name: "XRPUSDT",
			isValid: true,
			minAcceptableQuoteValue: parseEther("150"),
			minAcceptablePortionLF: parseEther("0.08"),
			tradingFee: parseEther("0.012"),
			maxLeverage: parseEther("12"),
			fundingRateEpochDuration: 86400,
			fundingRateWindowTime: 3600,
		},
		{
			symbolId: 4,
			name: "DOGEUSDT",
			isValid: true,
			minAcceptableQuoteValue: parseEther("300"),
			minAcceptablePortionLF: parseEther("0.04"),
			tradingFee: parseEther("0.02"),
			maxLeverage: parseEther("20"),
			fundingRateEpochDuration: 86400,
			fundingRateWindowTime: 3600,
		},
	]
}

function getDefaultSymbolsWithType(): SymbolWithType[] {
	return getDefaultSymbols().map(s => ({ ...s, symbolType: 1 }))
}

export function shouldBehaveLikeSymmioSymbolManager(): void {
	describe("SymmioSymbolManager", function () {
		let symbolManager: any
		let mockSymmio: any
		let admin: HardhatEthersSigner
		let modifier: HardhatEthersSigner
		let operator: HardhatEthersSigner
		let fgcrManager: HardhatEthersSigner
		let otherAccount: HardhatEthersSigner
		let defaultDailyLimits: {
			symbolAddition: number
			tradingFee: number
			validationState: number
			maxLeverage: number
			acceptableValues: number
			fundingState: number
			forceCloseGapRatio: number
		}

		beforeEach(async function () {
			const signers = await ethers.getSigners()
			;[admin, modifier, operator, fgcrManager, , otherAccount] = signers

			const MockSymmioFactory = await ethers.getContractFactory("MockSymbolManagerSymmio")
			mockSymmio = await MockSymmioFactory.deploy()
			await mockSymmio.waitForDeployment()

			const SymmioSymbolManagerFactory = await ethers.getContractFactory("SymmioSymbolManager")
			symbolManager = await SymmioSymbolManagerFactory.deploy(await mockSymmio.getAddress(), await admin.getAddress())
			await symbolManager.waitForDeployment()

			defaultDailyLimits = {
				symbolAddition: 5,
				tradingFee: 10,
				validationState: 10,
				maxLeverage: 10,
				acceptableValues: 10,
				fundingState: 10,
				forceCloseGapRatio: 10,
			}

			// Admin-side roles
			await symbolManager.connect(admin).grantRole(SETTER_ROLE, admin.address)
			await symbolManager.connect(admin).grantRole(PAUSER_ROLE, admin.address)
			await symbolManager.connect(admin).grantRole(UNPAUSER_ROLE, admin.address)

			await symbolManager.connect(admin).setDailyLimits(defaultDailyLimits)
			await symbolManager.connect(admin).setForceCloseGapRatioBounds(parseEther("0.005"), parseEther("0.05"))

			// Operator roles (adder/remover)
			await symbolManager.connect(admin).grantRole(SYMBOL_ADDER_ROLE, operator.address)
			await symbolManager.connect(admin).grantRole(SYMBOL_REMOVER_ROLE, operator.address)

			// Modifier (batch mutators + activateSymbols)
			await symbolManager.connect(admin).grantRole(SYMBOL_ADDER_ROLE, modifier.address)
			await symbolManager.connect(admin).grantRole(SYMBOL_TRADING_FEE_MANAGER_ROLE, modifier.address)
			await symbolManager.connect(admin).grantRole(SYMBOL_MAX_LEVERAGE_MANAGER_ROLE, modifier.address)
			await symbolManager.connect(admin).grantRole(SYMBOL_MIN_ACCEPTABLE_VALUES_MANAGER_ROLE, modifier.address)
			await symbolManager.connect(admin).grantRole(SYMBOL_FUNDING_STATE_MANAGER_ROLE, modifier.address)

			// Force-close-gap-ratio manager
			await symbolManager.connect(admin).grantRole(SYMBOL_FORCE_CLOSE_GAP_RATIO_MANAGER_ROLE, fgcrManager.address)

			// Populate the mock with some pre-existing symbols so loadSymmioSymbols has data to read
			for (const symbol of [...getDefaultSymbols(), ...getExtraSymbols()]) {
				await mockSymmio.setMockSymbol(symbol.symbolId, symbol)
			}
		})

		describe("Symbol Addition", function () {
			it("adds symbols within daily limit", async function () {
				const symbols = getDefaultSymbols()
				await expect(symbolManager.connect(operator).addSymbols(symbols)).to.not.be.reverted

				const dailyOps = await symbolManager.getDailyOperations()
				expect(dailyOps.symbolAddition).to.equal(symbols.length)
			})

			it("reverts when exceeding the daily limit", async function () {
				const symbols = [...getDefaultSymbols(), ...getExtraSymbols(), ...getExtraSymbols()]
				await expect(symbolManager.connect(operator).addSymbols(symbols)).to.be.revertedWithCustomError(symbolManager, "DailyLimitExceeded")
			})

			it("reverts on duplicate symbols", async function () {
				const symbols = getDefaultSymbols()
				await symbolManager.connect(operator).addSymbols(symbols)

				await expect(symbolManager.connect(operator).addSymbols(symbols))
					.to.be.revertedWithCustomError(symbolManager, "DuplicateSymbol")
					.withArgs(symbols[0].name)
			})
		})

		describe("Symbol Addition With Type", function () {
			it("adds symbols with type within daily limit", async function () {
				const symbols = getDefaultSymbolsWithType()
				await expect(symbolManager.connect(operator).addSymbolsWithType(symbols)).to.not.be.reverted

				const dailyOps = await symbolManager.getDailyOperations()
				expect(dailyOps.symbolAddition).to.equal(symbols.length)
			})

			it("reverts on duplicate symbols with type", async function () {
				const symbols = getDefaultSymbolsWithType()
				await symbolManager.connect(operator).addSymbolsWithType(symbols)

				await expect(symbolManager.connect(operator).addSymbolsWithType(symbols))
					.to.be.revertedWithCustomError(symbolManager, "DuplicateSymbol")
					.withArgs(symbols[0].name)
			})

			it("reverts on empty list", async function () {
				await expect(symbolManager.connect(operator).addSymbolsWithType([])).to.be.revertedWithCustomError(symbolManager, "InvalidSymbolsList")
			})
		})

		describe("Batch Operations", function () {
			const symbolIds = [1, 2]

			it("sets trading fees in batch", async function () {
				const fees = [parseEther("0.02"), parseEther("0.03")]
				await expect(symbolManager.connect(modifier).setSymbolTradingFeeBatch(symbolIds, fees))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("tradingFee", symbolIds)
			})

			it("activates symbols in batch", async function () {
				await expect(symbolManager.connect(modifier).activateSymbols(symbolIds))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("activateSymbols", symbolIds)
			})

			it("sets max leverage in batch", async function () {
				const leverages = [parseEther("20"), parseEther("25")]
				await expect(symbolManager.connect(modifier).setSymbolMaxLeverageBatch(symbolIds, leverages))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("maxLeverage", symbolIds)
			})

			it("sets acceptable values in batch", async function () {
				const minQuote = [parseEther("150"), parseEther("250")]
				const minPortionLF = [parseEther("0.15"), parseEther("0.25")]
				await expect(symbolManager.connect(modifier).setSymbolAcceptableValuesBatch(symbolIds, minQuote, minPortionLF))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("acceptableValues", symbolIds)
			})

			it("sets funding state in batch", async function () {
				const epochDurations = [72000, 86400]
				const windowTimes = [3000, 3600]
				await expect(symbolManager.connect(modifier).setSymbolFundingStateBatch(symbolIds, epochDurations, windowTimes))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("fundingState", symbolIds)
			})

			it("sets force close gap ratio in batch and only counts non-zero->non-zero against the limit", async function () {
				let ratios = [parseEther("0.01")]
				await expect(symbolManager.connect(fgcrManager).setForceCloseGapRatioBatch([1], ratios))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("forceCloseGapRatio", [1])

				let dailyOps = await symbolManager.getDailyOperations()
				expect(dailyOps.forceCloseGapRatio).to.equal(0)

				ratios = [parseEther("0.01"), parseEther("0.02")]
				await expect(symbolManager.connect(fgcrManager).setForceCloseGapRatioBatch(symbolIds, ratios))
					.to.emit(symbolManager, "BatchOperationExecuted")
					.withArgs("forceCloseGapRatio", symbolIds)

				dailyOps = await symbolManager.getDailyOperations()
				expect(dailyOps.forceCloseGapRatio).to.equal(1)
			})

			it("reverts on mismatched array lengths", async function () {
				const singleValue = [parseEther("0.01")]
				await expect(symbolManager.connect(modifier).setSymbolTradingFeeBatch(symbolIds, singleValue)).to.be.revertedWithCustomError(
					symbolManager,
					"InvalidArrayLengths",
				)
			})
		})

		describe("Daily Limits", function () {
			it("resets daily operations after 24 hours", async function () {
				await symbolManager.connect(operator).addSymbols(getDefaultSymbols())
				await time.increase(24 * 60 * 60)

				await symbolManager.connect(operator).addSymbols(getExtraSymbols())

				const dailyOps = await symbolManager.getDailyOperations()
				expect(dailyOps.symbolAddition).to.equal(getExtraSymbols().length)
			})

			it("allows admin to update daily limits", async function () {
				const newLimits = {
					symbolAddition: 10,
					tradingFee: 20,
					validationState: 20,
					maxLeverage: 20,
					acceptableValues: 20,
					fundingState: 20,
					forceCloseGapRatio: 20,
				}

				await expect(symbolManager.connect(admin).setDailyLimits(newLimits)).to.emit(symbolManager, "DailyLimitsUpdated")

				const limits = await symbolManager.getDailyLimits()
				expect(limits.symbolAddition).to.equal(newLimits.symbolAddition)
			})
		})

		describe("Access Control", function () {
			it("pauses and unpauses", async function () {
				await symbolManager.connect(admin).pause()
				await expect(symbolManager.connect(operator).addSymbols([getDefaultSymbols()[0]])).to.be.reverted

				await symbolManager.connect(admin).unpause()
				await expect(symbolManager.connect(operator).addSymbols([getDefaultSymbols()[0]])).to.not.be.reverted
			})

			it("rejects unauthorized callers from restricted ops", async function () {
				await expect(symbolManager.connect(otherAccount).setDailyLimits(defaultDailyLimits)).to.be.reverted
			})
		})

		describe("Symbol Management", function () {
			it("loads symbols from the Symmio mock", async function () {
				await expect(symbolManager.connect(admin).loadSymmioSymbols(0, 2)).to.emit(symbolManager, "SymmioSymbolsLoaded").withArgs(0, 2)
			})

			it("clears symbol hashes", async function () {
				await symbolManager.connect(admin).loadSymmioSymbols(0, 2)
				await expect(symbolManager.connect(admin).clearSymbolHashes()).to.emit(symbolManager, "SymbolHashesCleared").withArgs(admin.address)
			})
		})
	})
}
