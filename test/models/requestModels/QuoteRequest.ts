import { Builder } from "builder-pattern"
import { BigNumberish, ZeroAddress } from "ethers"

import type { SingleUpnlAndPriceSigStruct } from "../../../src/types/facets/PartyA/PartyAFacet.js"
import { decimal, getBlockTimestamp } from "../../utils/Common.js"
import { getDummySingleUpnlAndPriceSig } from "../../utils/SignatureUtils.js"
import { OrderType, PositionType } from "../Enums.js"
import { ethers } from "../../helpers/hardhat-connection.js"

const data = ethers.AbiCoder.defaultAbiCoder().encode(["string"], ["hello-world"])

export interface QuoteRequest {
	partyBWhiteList: string[]
	affiliate: string
	symbolId: BigNumberish
	positionType: PositionType
	orderType: OrderType
	price: BigNumberish
	quantity: BigNumberish
	cva: BigNumberish
	partyAmm: BigNumberish
	partyBmm: BigNumberish
	lf: BigNumberish
	maxFundingRate: BigNumberish
	deadline: Promise<BigNumberish> | BigNumberish
	upnlSig: Promise<SingleUpnlAndPriceSigStruct>
}

export interface QuoteRequestWithData {
	partyBWhiteList: string[]
	affiliate: string
	symbolId: BigNumberish
	positionType: PositionType
	orderType: OrderType
	price: BigNumberish
	quantity: BigNumberish
	cva: BigNumberish
	partyAmm: BigNumberish
	partyBmm: BigNumberish
	lf: BigNumberish
	deadline: Promise<BigNumberish> | BigNumberish
	upnlSig: Promise<SingleUpnlAndPriceSigStruct>
	data: any
}

const buildLimitDefaultQuoteRequest = (): QuoteRequest => ({
	partyBWhiteList: [],
	symbolId: 1,
	positionType: PositionType.LONG,
	orderType: OrderType.LIMIT,
	price: decimal(1n),
	quantity: decimal(100n),
	cva: decimal(22n),
	partyAmm: decimal(75n),
	partyBmm: decimal(40n),
	lf: decimal(3n),
	maxFundingRate: decimal(2n, 16),
	deadline: getBlockTimestamp(500n),
	affiliate: ZeroAddress,
	upnlSig: getDummySingleUpnlAndPriceSig(decimal(1n)),
})

const buildLimitDataQuoteRequest = (): QuoteRequestWithData => ({
	partyBWhiteList: [],
	symbolId: 1,
	positionType: PositionType.LONG,
	orderType: OrderType.LIMIT,
	price: decimal(1n),
	quantity: decimal(100n),
	cva: decimal(22n),
	partyAmm: decimal(75n),
	partyBmm: decimal(40n),
	lf: decimal(3n),
	deadline: getBlockTimestamp(500n),
	affiliate: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d", //FIXME find a better way
	upnlSig: getDummySingleUpnlAndPriceSig(decimal(1n)),
	data: data,
})

const buildMarketDefaultQuoteRequest = (): QuoteRequest => ({
	partyBWhiteList: [],
	symbolId: 1,
	positionType: PositionType.LONG,
	orderType: OrderType.MARKET,
	price: decimal(1n),
	quantity: decimal(1000n),
	cva: decimal(22n),
	partyAmm: decimal(75n),
	partyBmm: decimal(40n),
	lf: decimal(3n),
	maxFundingRate: decimal(2n, 16),
	deadline: getBlockTimestamp(500n),
	affiliate: "0xc6e7DF5E7b4f2A278906862b61205850344D4e7d", //FIXME find a better way
	upnlSig: getDummySingleUpnlAndPriceSig(decimal(1n)),
})

export const limitQuoteRequestBuilder = () => Builder(buildLimitDefaultQuoteRequest())
export const limitQuoteRequestWithDataBuilder = () => Builder(buildLimitDataQuoteRequest())
export const marketQuoteRequestBuilder = () => Builder(buildMarketDefaultQuoteRequest())
