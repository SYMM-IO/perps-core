// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
pragma solidity >=0.8.18;

import { Quote } from "../storages/QuoteStorage.sol";
import { LibQuoteAdjustment, QuoteAdjustmentData } from "../libraries/LibQuoteAdjustment.sol";

/// @notice Test-only wrapper for exercising quote adjustment arithmetic at raw 18-decimal boundaries.
contract QuoteAdjustmentHarness {
	function scalePositionAmounts(
		uint256 quantity,
		uint256 closedAmount,
		uint256 factor
	) external pure returns (uint256 openAmount, uint256 adjustedClosedAmount, uint256 adjustedQuantity) {
		return LibQuoteAdjustment.scalePositionAmounts(quantity, closedAmount, factor);
	}

	function previewPositionAmounts(
		uint256 quantity,
		uint256 closedAmount,
		uint256 factor
	) external pure returns (uint256 adjustedQuantity, uint256 adjustedClosedAmount) {
		Quote memory quote;
		quote.quantity = quantity;
		quote.closedAmount = closedAmount;
		QuoteAdjustmentData memory result = LibQuoteAdjustment.preview(quote, factor);
		return (result.quantity, result.closedAmount);
	}
}
