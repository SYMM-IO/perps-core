import { expect } from "chai"

import {
	calculatePositionAccounting,
	parseMuonPriceResponse,
	parsePartyATakeoverConfig,
	parsePartyATakeoverStep,
} from "../../scripts/upgrade/utils/partyATakeover.js"

describe("PartyA takeover script utilities", function () {
	it("calculates the live HyperEVM long-position loss and funding claim", function () {
		const accounting = calculatePositionAccounting(
			0,
			50_626_415_511_838_653n,
			23_611_001_104_264_700n,
			18_776_521_000_000_000_000n,
			77_940_624_625_078_822_142n,
		)

		expect(accounting.pricePnl).to.equal(-507_255_495_947_514_887n)
		expect(accounting.partyANetPnl).to.equal(-78_447_880_121_026_337_029n)
		expect(accounting.partyBClaim).to.equal(78_447_880_121_026_337_029n)
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

	it("validates Muon identity, order, prices, and timestamp", function () {
		const result = parseMuonPriceResponse(
			{
				success: true,
				result: {
					data: {
						timestamp: 1_785_226_338,
						result: {
							chainId: "999",
							symmio: "0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
							latestBlockNumber: "41653265",
							quoteIds: [7076],
							prices: ["23611001104264700"],
							symbols: ["BIO::22..D2_SFLOW"],
						},
					},
				},
			},
			999,
			"0x99641E06d38F327166b3a48f86Ca2cbB3B4fB7EB",
			[7076n],
		)

		expect(result.quoteIds).to.deep.equal([7076n])
		expect(result.prices).to.deep.equal([23_611_001_104_264_700n])
		expect(result.symbols).to.deep.equal(["BIO::22..D2_SFLOW"])
	})
})
