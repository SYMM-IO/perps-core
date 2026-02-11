// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

/// @notice Events emitted by the SymmioHookFacet
interface ISymmioHookFacetEvents {
	/// @notice Emitted when a virtual account is deleted after all its positions are closed
	event VirtualAccountDeleted(address indexed account, address indexed parent);
}

/// @notice Hook interface called by Symmio core on position lifecycle events
interface ISymmioHookFacet is ISymmioHookFacetEvents, IAccountLayerErrors {
	/// @notice Called when a position is opened (no-op)
	/// @param quoteId The quote identifier
	/// @param filledAmount The filled quantity
	/// @param openedPrice The execution price
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onOpenPosition(uint256 quoteId, uint256 filledAmount, uint256 openedPrice, address partyA, address partyB) external;

	/// @notice Called when a position is closed; removes quoteId from the virtual account
	/// @param quoteId The closed quote identifier
	/// @param filledAmount The filled close quantity
	/// @param closedPrice The close execution price
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onClosePosition(uint256 quoteId, uint256 filledAmount, uint256 closedPrice, address partyA, address partyB) external;

	/// @notice Called when a quote is cancelled; removes quoteId from the virtual account
	/// @param quoteId The cancelled quote identifier
	/// @param partyA The trader address
	/// @param partyB The hedger address
	function onCancelQuote(uint256 quoteId, address partyA, address partyB) external;

	/// @notice Called when a fee is charged (no-op)
	/// @param quoteId The quote identifier
	/// @param amount The fee amount
	/// @param partyA The trader address
	/// @param partyB The hedger address
	/// @param symbolId The symbol identifier
	/// @param affiliate The affiliate address
	/// @param feeType The type of fee charged
	function onFeeCharged(
		uint256 quoteId,
		uint256 amount,
		address partyA,
		address partyB,
		uint256 symbolId,
		address affiliate,
		uint8 feeType
	) external;
}
