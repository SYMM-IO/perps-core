import type { HighLowPriceSigStruct } from "../../src/types/facets/ForceActions/ForceActionsFacet.js"
import type { PairUpnlSigStructOutput } from "../../src/types/facets/FundingRate/FundingRateFacet.js"
import type { SingleUpnlAndPriceSigStruct } from "../../src/types/facets/PartyA/PartyAFacet.js"
import type { QuotePriceSigStruct } from "../../src/types/facets/PartyBLiquidation/PartyBLiquidationFacet.js"
import type {
	QuoteSettlementDataStructOutput,
	SettlementSigStructOutput,
	UnifiedQuoteSettlementDataStruct,
	UnifiedSettlementSigStruct,
} from "../../src/types/facets/Settlement/ISettlementFacet.js"
import type { DeferredLiquidationSigStruct, PairUpnlAndPriceSigStruct, SingleUpnlSigStruct } from "../../src/types/interfaces/ISymmio.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { getBlockTimestamp } from "./Common.js"

export async function getDummySingleUpnlSig(upnl: bigint = 0n): Promise<SingleUpnlSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(700n),
		upnl: upnl,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummySingleUpnlWithPendingBalanceSig(upnl: bigint = 0n, pendingBalance: bigint = 0n): Promise<any> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(700n),
		upnl: upnl,
		pendingBalance: pendingBalance,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummyLiquidationSig(
	liquidationId: string,
	upnl: bigint = 0n,
	symbolIds: bigint[],
	prices: bigint[],
	totalUnrealizedLoss: bigint,
	allocatedBalance: bigint,
): Promise<DeferredLiquidationSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		liquidationBlockNumber: 1,
		liquidationTimestamp: await getBlockTimestamp(),
		liquidationAllocatedBalance: allocatedBalance,
		liquidationId: liquidationId,
		upnl: upnl,
		totalUnrealizedLoss: totalUnrealizedLoss,
		prices: prices,
		symbolIds: symbolIds,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummySingleUpnlAndPriceSig(price: bigint = 1n, upnl: bigint = 0n): Promise<SingleUpnlAndPriceSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(700n),
		upnl: upnl,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
		price: price,
	}
}

export async function getDummyPairUpnlAndPriceSig(
	price: bigint = 1n,
	upnlPartyA: bigint = 0n,
	upnlPartyB: bigint = 0n,
): Promise<PairUpnlAndPriceSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		upnlPartyA: upnlPartyA,
		upnlPartyB: upnlPartyB,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
		price: price,
	}
}

export async function getDummyPairUpnlSig(upnlPartyA: bigint = 0n, upnlPartyB: bigint = 0n): Promise<PairUpnlSigStructOutput> {
	return {
		reqId: "0x",
		timestamp: BigInt(await getBlockTimestamp()),
		upnlPartyA: upnlPartyA,
		upnlPartyB: upnlPartyB,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: 0n,
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		} as any,
	} as any
}

export async function getDummySettlementSig(
	upnlPartyA: bigint = 0n,
	upnlPartyBs: bigint[] = [],
	quotesSettlementsData: QuoteSettlementDataStructOutput[] = [],
): Promise<SettlementSigStructOutput> {
	return {
		reqId: "0x",
		timestamp: BigInt(await getBlockTimestamp()),
		upnlPartyA: upnlPartyA,
		upnlPartyBs: upnlPartyBs,
		quotesSettlementsData: quotesSettlementsData,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: 0n,
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		} as any,
	} as any
}

export async function getDummyHighLowPriceSig(
	startTime: bigint = 0n,
	endTime: bigint = 0n,
	lowest: bigint = 0n,
	highest: bigint = 0n,
	currentPrice: bigint = 0n,
	averagePrice: bigint = 0n,
	symbolId: bigint = 0n,
	upnlPartyB: bigint = 0n,
	upnlPartyA: bigint = 0n,
): Promise<HighLowPriceSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		highest: highest,
		lowest: lowest,
		currentPrice: currentPrice,
		averagePrice: averagePrice,
		startTime: startTime,
		endTime: endTime,
		symbolId: symbolId,
		upnlPartyB: upnlPartyB,
		upnlPartyA: upnlPartyA,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummyPriceSig(quoteIds: bigint[] = [], prices: bigint[] = []): Promise<QuotePriceSigStruct> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		quoteIds: quoteIds,
		prices: prices,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummyPairUpnlAndPricesSig(
	prices: bigint[] = [1n],
	symbolIds: bigint[] = [1n],
	upnlPartyA: bigint = 0n,
	upnlPartyB: bigint = 0n,
): Promise<any> {
	return {
		reqId: "0x",
		timestamp: await getBlockTimestamp(),
		upnlPartyA: upnlPartyA,
		upnlPartyB: upnlPartyB,
		symbolIds: symbolIds,
		prices: prices,
		gatewaySignature: ethers.ZeroAddress,
		sigs: {
			signature: "0",
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		},
	}
}

export async function getDummyUnifiedSettlementSig(
	partyB: string = ethers.ZeroAddress,
	upnlPartyB: bigint = 0n,
	upnlPartyBPerPartyA: bigint[] = [],
	partyAs: string[] = [],
	upnlPartyAs: bigint[] = [],
	quotesSettlementsData: UnifiedQuoteSettlementDataStruct[] = [],
): Promise<UnifiedSettlementSigStruct> {
	return {
		reqId: "0x",
		timestamp: BigInt(await getBlockTimestamp()),
		quotesSettlementsData: quotesSettlementsData,
		partyB: partyB,
		upnlPartyB: upnlPartyB,
		upnlPartyBPerPartyA: upnlPartyBPerPartyA,
		partyAs: partyAs,
		upnlPartyAs: upnlPartyAs,
		gatewaySignature: "0x",
		sigs: {
			signature: 0n,
			owner: ethers.ZeroAddress,
			nonce: ethers.ZeroAddress,
		} as any,
	} as UnifiedSettlementSigStruct
}
