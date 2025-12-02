// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./ForceActionsFacetEvents.sol";

interface IForceActionsFacet is ForceActionsFacetEvents {
	function forceCancelQuote(uint256 quoteId) external;

	function forceCancelCloseRequest(uint256 quoteId) external;

	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external;

	function settleAndForceClosePosition(
		uint256 quoteId,
		HighLowPriceSig memory highLowPriceSig,
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices
	) external;

	function realizeUPNLMasterAccount(uint256 quoteId, CrossSettlementSig memory settlementSig, uint256[] memory updatedPrices) external;
}

library ForceCloseErrors {
	// -----------------------------------------------------------------------------
	// Custom errors
	//
	// NOTE:
	// The following custom error declarations are used by the ForceActions facet
	// implementation to replace string-based revert reasons with more gas efficient
	// and descriptive error types. 

	/// @notice Thrown when a quote is in an invalid state for the attempted action.
	/// This mirrors the old require with reason "PartyAFacet: Invalid state".
	error InvalidState();

	/// @notice Thrown when a cooldown period has not yet elapsed.
	/// This covers several cooldown related checks previously using
	/// "PartyAFacet: Cooldown not reached".
	error CooldownNotReached();

	/// @notice Thrown when a force close request has expired.
	error CloseRequestExpired();

	/// @notice Thrown when a quote's order type is not LIMIT as required.
	error InvalidOrderType();

	/// @notice Thrown when the supplied average price is outside the high/low bounds.
	error InvalidAveragePrice();

	/// @notice Thrown when the requested close price has not been reached within
	/// the required gap ratio threshold.
	error RequestedClosePriceNotReached();

	/// @notice Thrown when the signature period for a force close is too short.
	error InvalidSignaturePeriod();

	/// @notice Thrown when a forced close would leave the counterparty insolvent.
	error PartyAWillBeInsolvent();

	/// @notice Thrown when a master account mode is inactive but an action requires it.
	error MasterAccountModeInactive();

	/// @notice Thrown when an action references a quote belonging to a different partyB.
	error InvalidQuote();
}
