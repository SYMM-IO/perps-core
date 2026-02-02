// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "../storages/QuoteStorage.sol";

library LibPartiesEvents {
	event AcceptCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId);
	event AcceptCancelCloseRequest(uint256 quoteId, QuoteStatus quoteStatus); // For backward compatibility, will be removed in future

	event RequestToClosePosition(
		address partyA,
		address partyB,
		uint256 quoteId,
		uint256 closePrice,
		uint256 quantityToClose,
		OrderType orderType,
		uint256 deadline,
		QuoteStatus quoteStatus,
		uint256 closeId
	);
	event RequestToClosePosition(
		address partyA,
		address partyB,
		uint256 quoteId,
		uint256 closePrice,
		uint256 quantityToClose,
		OrderType orderType,
		uint256 deadline,
		QuoteStatus quoteStatus
	); // For backward compatibility, will be removed in future

	event RequestToCancelCloseRequest(address partyA, address partyB, uint256 quoteId, QuoteStatus quoteStatus, uint256 closeId);
	event RequestToCancelCloseRequest(address partyA, address partyB, uint256 quoteId, QuoteStatus quoteStatus); // For backward compatibility, will be removed in future

	event FillCloseRequest(
		uint256 quoteId,
		address partyA,
		address partyB,
		uint256 filledAmount,
		uint256 closedPrice,
		QuoteStatus quoteStatus,
		uint256 closeId
	);
	event FillCloseRequest(uint256 quoteId, address partyA, address partyB, uint256 filledAmount, uint256 closedPrice, QuoteStatus quoteStatus); // For backward compatibility, will be removed in future
}

