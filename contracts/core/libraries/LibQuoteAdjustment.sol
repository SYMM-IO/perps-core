// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Quote } from "../storages/QuoteStorage.sol";

struct QuoteAdjustmentData {
	uint256 factor;
	uint256 quantity;
	uint256 openedPrice;
	uint256 initialOpenedPrice;
	uint256 requestedOpenPrice;
	uint256 marketPrice;
	uint256 closedAmount;
	uint256 avgClosedPrice;
	uint256 quantityToClose;
	uint256 requestedClosePrice;
}

/// @title LibQuoteAdjustment
/// @notice Shared quote-unit conversion used by physical restatement and normalized views
library LibQuoteAdjustment {
	function preview(Quote memory quote, uint256 factor) internal pure returns (QuoteAdjustmentData memory result) {
		uint256 oldQuantity = quote.quantity;
		result.factor = factor;
		result.quantity = Math.mulDiv(oldQuantity, factor, 1e18);
		require(result.quantity > 0, "SymbolAdjustmentFacet: Quantity underflow");
		result.openedPrice = _scalePrice(oldQuantity, quote.openedPrice, result.quantity);
		result.initialOpenedPrice = _scalePrice(oldQuantity, quote.initialOpenedPrice, result.quantity);
		result.requestedOpenPrice = _scalePrice(oldQuantity, quote.requestedOpenPrice, result.quantity);
		result.marketPrice = _scalePrice(oldQuantity, quote.marketPrice, result.quantity);

		result.closedAmount = quote.closedAmount;
		result.avgClosedPrice = quote.avgClosedPrice;
		if (quote.closedAmount > 0) {
			result.closedAmount = Math.mulDiv(quote.closedAmount, factor, 1e18);
			require(result.closedAmount > 0, "SymbolAdjustmentFacet: Closed amount underflow");
			result.avgClosedPrice = _scalePrice(quote.closedAmount, quote.avgClosedPrice, result.closedAmount);
		}
		require(result.quantity > result.closedAmount, "SymbolAdjustmentFacet: Open amount underflow");

		result.quantityToClose = quote.quantityToClose;
		result.requestedClosePrice = quote.requestedClosePrice;
		if (quote.quantityToClose > 0) {
			result.quantityToClose = Math.mulDiv(quote.quantityToClose, factor, 1e18);
			require(result.quantityToClose > 0, "SymbolAdjustmentFacet: Close amount underflow");
			result.requestedClosePrice = _scalePrice(quote.quantityToClose, quote.requestedClosePrice, result.quantityToClose);
		}
	}

	function toVenueUnits(Quote memory quote, uint256 factor) internal pure returns (Quote memory) {
		if (factor == 1e18) return quote;
		QuoteAdjustmentData memory result = preview(quote, factor);
		quote.quantity = result.quantity;
		quote.openedPrice = result.openedPrice;
		quote.initialOpenedPrice = result.initialOpenedPrice;
		quote.requestedOpenPrice = result.requestedOpenPrice;
		quote.marketPrice = result.marketPrice;
		quote.closedAmount = result.closedAmount;
		quote.avgClosedPrice = result.avgClosedPrice;
		quote.quantityToClose = result.quantityToClose;
		quote.requestedClosePrice = result.requestedClosePrice;
		return quote;
	}

	function _scalePrice(uint256 oldQuantity, uint256 oldPrice, uint256 newQuantity) private pure returns (uint256) {
		if (oldPrice == 0) return 0;
		return Math.mulDiv(oldQuantity, oldPrice, newQuantity);
	}
}
