// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Quote, QuoteStatus } from "../../storages/QuoteStorage.sol";

library LibQuoteState {
	function requireOpenPosition(Quote storage quote) internal view {
		require(
			quote.quoteStatus == QuoteStatus.OPENED ||
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING ||
				quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
			"LibQuote: Invalid state"
		);
	}
}
