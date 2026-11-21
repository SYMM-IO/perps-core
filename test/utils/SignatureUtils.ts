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
import type {
	DeferredLiquidationSigStruct,
	PairUpnlAndPriceSigStruct,
	SingleUpnlSigStruct,
	SingleUpnlWithPendingBalanceSigStruct,
} from "../../src/types/interfaces/ISymmio.js"
import { ethers } from "../helpers/hardhat-connection.js"
import { getBlockTimestamp } from "./Common.js"

/// @notice Dummy 32-byte Muon request ID used by tests (mock verifier accepts the crypto).
/// @dev Must stay 32 bytes: production verification rejects any other reqId length.
export const DUMMY_REQ_ID = "0x" + "11".repeat(32)

export async function getDummySingleUpnlSig(upnl: bigint = 0n): Promise<SingleUpnlSigStruct> {
	return {
		reqId: DUMMY_REQ_ID,
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

export async function getDummySingleUpnlWithPendingBalanceSig(
	upnl: bigint = 0n,
	pendingBalance: bigint = 0n,
	scaledLockedBalance: bigint = 0n,
	fundingDebt: bigint = 0n,
): Promise<SingleUpnlWithPendingBalanceSigStruct> {
	return {
		reqId: DUMMY_REQ_ID,
		timestamp: await getBlockTimestamp(700n),
		upnl: upnl,
		fundingDebt: fundingDebt,
		pendingBalance: pendingBalance,
		scaledLockedBalance: scaledLockedBalance,
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
		reqId: DUMMY_REQ_ID,
		timestamp: await getBlockTimestamp(),
		liquidationBlockNumber: 1,
		liquidationTimestamp: await getBlockTimestamp(),
		liquidationAllocatedBalance: allocatedBalance,
		// Most callers use compact labels (e.g. 0x10); pad them to the contract's required 32 bytes.
		liquidationId: ethers.zeroPadValue(liquidationId, 32),
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
		reqId: DUMMY_REQ_ID,
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
