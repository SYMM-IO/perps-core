// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PositionType, OrderType, SolverFeeCaps } from "../storages/QuoteStorage.sol";

/// @title LibSendQuoteEvents
/// @notice Library to help emit SendQuote events while avoiding stack too deep errors
library LibSendQuoteEvents {
	// For backward compatibility
	event SendQuote(
		address partyA,
		uint256 quoteId,
		address[] partyBsWhiteList,
		uint256 symbolId,
		PositionType positionType,
		OrderType orderType,
		uint256 price,
		uint256 marketPrice,
		uint256 quantity,
		uint256 cva,
		uint256 lf,
		uint256 partyAmm,
		uint256 partyBmm,
		uint256 tradingFee,
		uint256 deadline
	);

	// paramsData is abi.encode(symbolId, positionType, orderType, price, marketPrice, quantity, cva, lf, partyAmm, partyBmm, tradingFee, deadline)
	event SendQuote(address partyA, uint256 quoteId, address[] partyBsWhiteList, address affiliate, bytes paramsData, bytes data);
	event SendQuoteSolverFeeCaps(address indexed partyA, uint256 indexed quoteId, uint256 openRateCap, uint256 closeRateCap);

	/// @notice Parameters for emitting SendQuote events, grouped to avoid stack too deep errors.
	struct SendQuoteEventParams {
		address partyA;
		uint256 quoteId;
		address[] partyBsWhiteList;
		uint256 symbolId;
		PositionType positionType;
		OrderType orderType;
		uint256 price;
		uint256 marketPrice;
		uint256 quantity;
		uint256 cva;
		uint256 lf;
		uint256 partyAmm;
		uint256 partyBmm;
		uint256 tradingFee;
		uint256 deadline;
		address affiliate;
		SolverFeeCaps solverFeeCaps;
		bytes data;
	}

	/// @notice Emits both legacy and new SendQuote events for backward compatibility.
	function emitSendQuoteEvents(SendQuoteEventParams memory params) internal {
		// Emit deprecated event for backward compatibility
		emit SendQuote(
			params.partyA,
			params.quoteId,
			params.partyBsWhiteList,
			params.symbolId,
			params.positionType,
			params.orderType,
			params.price,
			params.marketPrice,
			params.quantity,
			params.cva,
			params.lf,
			params.partyAmm,
			params.partyBmm,
			params.tradingFee,
			params.deadline
		);

		// Emit new event with affiliate and data
		// Using abi.encode for easy decoding with standard ABI decoders
		bytes memory paramsData = abi.encode(
			params.symbolId,
			params.positionType,
			params.orderType,
			params.price,
			params.marketPrice,
			params.quantity,
			params.cva,
			params.lf,
			params.partyAmm,
			params.partyBmm,
			params.tradingFee,
			params.deadline
		);
		emit SendQuote(params.partyA, params.quoteId, params.partyBsWhiteList, params.affiliate, paramsData, params.data);

		if (params.solverFeeCaps.openRateCap > 0 || params.solverFeeCaps.closeRateCap > 0) {
			emit SendQuoteSolverFeeCaps(params.partyA, params.quoteId, params.solverFeeCaps.openRateCap, params.solverFeeCaps.closeRateCap);
		}
	}
}
