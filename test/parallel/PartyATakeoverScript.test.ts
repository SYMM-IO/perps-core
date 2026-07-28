import { expect } from "chai"

import {
	calculatePositionAccounting,
	legacyLiquidationPriceSlots,
	liquidationSnapshotFlagSlot,
	parsePartyATakeoverConfig,
	parsePartyATakeoverStep,
	partyBSymbolSnapshotSlots,
	readFrozenLiquidationPrices,
} from "../../scripts/upgrade/utils/partyATakeover.js"
import { ethers } from "../helpers/hardhat-connection.js"

describe("PartyA takeover script utilities", function () {
	const diamond = "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB"
	const partyA = "0x518fCA8AAB001c4f3A14c388ba4f821D46d6BF41"
	const partyB = "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775"
	const liquidationId = "0xd8ff1222eee159c6e02452943a7923c3aed02a4f16afb025188ee105cb9e5fc6"

	it("calculates the frozen-price HyperEVM loss and funding claim", function () {
		const accounting = calculatePositionAccounting(
			0,
			50_626_415_511_838_653n,
			35_046_846_583_671_847n,
			18_776_521_000_000_000_000n,
			77_940_624_625_078_822_142n,
		)

		expect(accounting.pricePnl).to.equal(-292_530_103_150_671_524n)
		expect(accounting.partyANetPnl).to.equal(-78_233_154_728_229_493_666n)
		expect(accounting.partyBClaim).to.equal(78_233_154_728_229_493_666n)
	})

	it("calculates short-position PnL with the opposite price direction", function () {
		const accounting = calculatePositionAccounting(1, 10n * 10n ** 18n, 8n * 10n ** 18n, 3n * 10n ** 18n, 1n * 10n ** 18n)

		expect(accounting.pricePnl).to.equal(6n * 10n ** 18n)
		expect(accounting.partyANetPnl).to.equal(5n * 10n ** 18n)
		expect(accounting.partyBClaim).to.equal(0n)
	})

	it("accepts only the supported resumable steps", function () {
		expect(parsePartyATakeoverStep(undefined)).to.equal("inspect")
		expect(parsePartyATakeoverStep("POSITIONS")).to.equal("positions")
		expect(() => parsePartyATakeoverStep("takeover")).to.throw("Invalid TAKEOVER_STEP")
	})

	it("normalizes the minimum safe config", function () {
		const config = parsePartyATakeoverConfig({
			chainId: 999,
			diamondAddress: "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
			partyA: "0x518fCA8AAB001c4f3A14c388ba4f821D46d6BF41",
			partyB: "0xf62a670cda28FfAE65eE2a42D6cf6CF05EC5E775",
		})

		expect(config.chainId).to.equal(999)
		expect(config.partyA).to.equal("0x518fCA8AAB001c4f3A14c388ba4f821D46d6BF41")
		expect(() =>
			parsePartyATakeoverConfig({
				...config,
				partyB: config.partyA,
			}),
		).to.throw("must be different")
	})

	it("derives the deployed legacy frozen-price slots", function () {
		expect(liquidationSnapshotFlagSlot(partyA, liquidationId)).to.equal("0xd04ac276de55a92a389e564c52f66b92bbbe1bbee30df0848991f4cabf7f40e8")
		expect(legacyLiquidationPriceSlots(partyA, 14n)).to.deep.equal({
			price: "0xa291388cb2c4f1ac31d8acec5e6542bcaed41222b932e7d89c83cb055622f15e",
			timestamp: "0xa291388cb2c4f1ac31d8acec5e6542bcaed41222b932e7d89c83cb055622f15f",
		})
	})

	it("reads and validates a legacy frozen liquidation price", async function () {
		const slots = legacyLiquidationPriceSlots(partyA, 14n)
		const words = new Map<string, string>([
			[slots.price, ethers.toBeHex(35_046_846_583_671_847n, 32)],
			[slots.timestamp, ethers.toBeHex(1_781_726_682n, 32)],
		])
		const provider = {
			getStorage: async (_address: string, position: string) => words.get(position) ?? ethers.ZeroHash,
		}

		const prices = await readFrozenLiquidationPrices(provider, diamond, partyA, liquidationId, 1_781_726_682n, [{ partyB, symbolId: 14n }])

		expect(prices).to.deep.equal([
			{
				partyB,
				symbolId: 14n,
				price: 35_046_846_583_671_847n,
				source: "legacy-symbol",
			},
		])
	})

	it("reads a PartyB-symbol liquidation snapshot price", async function () {
		const flagSlot = liquidationSnapshotFlagSlot(partyA, liquidationId)
		const slots = partyBSymbolSnapshotSlots(partyA, liquidationId, partyB, 14n)
		const words = new Map<string, string>([
			[flagSlot, ethers.toBeHex(1n, 32)],
			[slots.isSet, ethers.toBeHex(1n, 32)],
			[slots.price, ethers.toBeHex(35_046_846_583_671_847n, 32)],
		])
		const provider = {
			getStorage: async (_address: string, position: string) => words.get(position) ?? ethers.ZeroHash,
		}

		const [price] = await readFrozenLiquidationPrices(provider, diamond, partyA, liquidationId, 1_781_726_682n, [{ partyB, symbolId: 14n }])

		expect(price.price).to.equal(35_046_846_583_671_847n)
		expect(price.source).to.equal("party-b-symbol-snapshot")
	})

	it("rejects a legacy price from a different liquidation timestamp", async function () {
		const slots = legacyLiquidationPriceSlots(partyA, 14n)
		const words = new Map<string, string>([
			[slots.price, ethers.toBeHex(35_046_846_583_671_847n, 32)],
			[slots.timestamp, ethers.toBeHex(1_781_726_681n, 32)],
		])
		const provider = {
			getStorage: async (_address: string, position: string) => words.get(position) ?? ethers.ZeroHash,
		}

		let failure: unknown
		try {
			await readFrozenLiquidationPrices(provider, diamond, partyA, liquidationId, 1_781_726_682n, [{ partyB, symbolId: 14n }])
		} catch (error) {
			failure = error
		}
		expect(failure).to.be.instanceOf(Error)
		expect((failure as Error).message).to.contain("timestamp mismatch")
	})
})
