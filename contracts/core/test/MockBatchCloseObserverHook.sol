// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { IViewFacet } from "../facets/ViewFacet/IViewFacet.sol";
import { IViewFacetQuote } from "../facets/ViewFacetQuote/IViewFacetQuote.sol";
import { Quote, QuoteStatus } from "../storages/QuoteStorage.sol";

contract MockBatchCloseObserverHook is ISymmioHook {
	address public immutable SYMMIO;
	uint256[] public monitoredQuoteIds;
	bool public firstCloseSawFinalizedBatch;
	uint256 public firstClosePartyAAllocated;
	uint256 public firstClosePartyBAllocated;
	uint256 public closeCallCount;
	uint256 public closeFeeCallCount;

	constructor(address symmio_, uint256[] memory quoteIds_) {
		SYMMIO = symmio_;
		monitoredQuoteIds = quoteIds_;
	}

	function onOpenPosition(uint256, uint256, uint256, address, address) external pure override {}

	function onClosePosition(uint256, uint256, uint256, address partyA, address partyB) external override {
		if (closeCallCount == 0) {
			bool finalized = true;
			for (uint256 i = 0; i < monitoredQuoteIds.length; i++) {
				Quote memory quote = IViewFacetQuote(SYMMIO).getQuote(monitoredQuoteIds[i]);
				if (quote.quoteStatus != QuoteStatus.CLOSED || quote.closedAmount != quote.quantity) finalized = false;
			}
			firstCloseSawFinalizedBatch = finalized;
			firstClosePartyAAllocated = IViewFacet(SYMMIO).allocatedBalanceOfPartyA(partyA);
			(firstClosePartyBAllocated, , , , , , , , ) = IViewFacet(SYMMIO).balanceInfoOfPartyB(partyB, partyA);
		}
		closeCallCount++;
	}

	function onCancelQuote(uint256, address, address) external pure override {}

	function onCloseExpired(uint256, address, address) external pure override {}

	function onFeeCharged(uint256, uint256, address, address, uint256, address, TradingFeeType feeType) external override {
		if (feeType == TradingFeeType.CLOSE) closeFeeCallCount++;
	}

	function onLiquidationSettled(address) external pure override {}
}
