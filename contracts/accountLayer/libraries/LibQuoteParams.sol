// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISymmio } from "../interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "../interfaces/IAccountLayerErrors.sol";

/// @notice Decoded parameters from a sendQuote call
struct QuoteParams {
	uint256 symbolId;
	ISymmio.PositionType positionType;
	uint256 cva;
	uint256 lf;
	uint256 partyAmm;
	uint256 quantity;
	uint256 price;
	ISymmio.OrderType orderType;
	ISymmio.SingleUpnlAndPriceSig sig;
	address affiliate;
}

/// @notice Library for decoding sendQuote calldata into a normalized QuoteParams struct
library LibQuoteParams {
	bytes4 internal constant SEND_QUOTE_SELECTOR = 0x7f2755b2;
	bytes4 internal constant SEND_QUOTE_WITH_AFFILIATE_SELECTOR = 0x40f1310c;
	bytes4 internal constant SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR = 0xa7f3b34b;

	/// @notice Decodes sendQuote calldata into a QuoteParams struct based on the function selector
	function decodeQuoteParams(bytes calldata cd) external pure returns (QuoteParams memory) {
		bytes4 selector = bytes4(cd[:4]);

		if (selector == SEND_QUOTE_WITH_AFFILIATE_SELECTOR) {
			(
				,
				uint256 symbolId,
				ISymmio.PositionType positionType,
				ISymmio.OrderType orderType,
				uint256 price,
				uint256 quantity,
				uint256 cva,
				uint256 lf,
				uint256 partyAmm,
				,
				,
				,
				address affiliate,
				ISymmio.SingleUpnlAndPriceSig memory sig
			) = abi.decode(
					cd[4:],
					(
						address[],
						uint256,
						ISymmio.PositionType,
						ISymmio.OrderType,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						address,
						ISymmio.SingleUpnlAndPriceSig
					)
				);
			return QuoteParams(symbolId, positionType, cva, lf, partyAmm, quantity, price, orderType, sig, affiliate);
		} else if (selector == SEND_QUOTE_SELECTOR) {
			(
				,
				uint256 symbolId,
				ISymmio.PositionType positionType,
				ISymmio.OrderType orderType,
				uint256 price,
				uint256 quantity,
				uint256 cva,
				uint256 lf,
				uint256 partyAmm,
				,
				,
				,
				ISymmio.SingleUpnlAndPriceSig memory sig
			) = abi.decode(
					cd[4:],
					(
						address[],
						uint256,
						ISymmio.PositionType,
						ISymmio.OrderType,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						ISymmio.SingleUpnlAndPriceSig
					)
				);
			return QuoteParams(symbolId, positionType, cva, lf, partyAmm, quantity, price, orderType, sig, address(0));
		} else if (selector == SEND_QUOTE_WITH_AFFILIATE_AND_DATA_SELECTOR) {
			(
				,
				uint256 symbolId,
				ISymmio.PositionType positionType,
				ISymmio.OrderType orderType,
				uint256 price,
				uint256 quantity,
				uint256 cva,
				uint256 lf,
				uint256 partyAmm,
				,
				,
				address affiliate,
				ISymmio.SingleUpnlAndPriceSig memory sig,

			) = abi.decode(
					cd[4:],
					(
						address[],
						uint256,
						ISymmio.PositionType,
						ISymmio.OrderType,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						uint256,
						address,
						ISymmio.SingleUpnlAndPriceSig,
						bytes
					)
				);
			return QuoteParams(symbolId, positionType, cva, lf, partyAmm, quantity, price, orderType, sig, affiliate);
		}
		revert IAccountLayerErrors.InvalidSelector();
	}
}
