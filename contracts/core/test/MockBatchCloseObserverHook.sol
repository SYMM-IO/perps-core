// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { ISymmioHook } from "../interfaces/ISymmioHook.sol";
import { IViewFacetQuote } from "../facets/ViewFacetQuote/IViewFacetQuote.sol";
import { Quote, QuoteStatus } from "../storages/QuoteStorage.sol";

contract MockBatchCloseObserverHook is ISymmioHook {
	address public immutable SYMMIO;
	uint256[] public monitoredQuoteIds;
	bool public firstCloseSawOnlyCurrentQuoteFinalized;
	uint256 public firstCloseQuoteId;
	uint256 public closeCallCount;
	uint256 public closeFeeCallCount;

	constructor(address symmio_, uint256[] memory quoteIds_) {
		SYMMIO = symmio_;
		monitoredQuoteIds = quoteIds_;
	}

	function onOpenPosition(uint256, uint256, uint256, address, address) external pure override {}

	function onClosePosition(uint256 quoteId, uint256, uint256, address, address) external override {
		if (closeCallCount == 0) {
			Quote memory currentQuote = IViewFacetQuote(SYMMIO).getQuote(quoteId);
			bool onlyCurrentFinalized = currentQuote.quoteStatus == QuoteStatus.CLOSED && currentQuote.closedAmount == currentQuote.quantity;
			for (uint256 i = 0; i < monitoredQuoteIds.length; i++) {
				if (monitoredQuoteIds[i] == quoteId) continue;
				Quote memory quote = IViewFacetQuote(SYMMIO).getQuote(monitoredQuoteIds[i]);
				if (quote.quoteStatus == QuoteStatus.CLOSED || quote.closedAmount == quote.quantity) onlyCurrentFinalized = false;
			}
			firstCloseSawOnlyCurrentQuoteFinalized = onlyCurrentFinalized;
			firstCloseQuoteId = quoteId;
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
