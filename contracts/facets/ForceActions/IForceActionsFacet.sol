// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./ForceActionsFacetEvents.sol";

/// @title ForceActionsFacet Interface
/// @notice Exposes PartyA-driven “force actions” for quotes and positions when
///         PartyB is unresponsive or subject to liquidation logic.
/// @dev The implementation lives in ForceActionsFacet + ForceActionsFacetImpl.

interface IForceActionsFacet is ForceActionsFacetEvents {
	/**
	 * @notice Forces the cancellation of a quote when PartyB is not responsive
	 *         for at least the configured forceCancelCooldown.
	 *
	 * @dev
	 * - Only applicable to quotes in CANCEL_PENDING state.
	 * - Checks:
	 *   - quote.quoteStatus == QuoteStatus.CANCEL_PENDING
	 *   - block.timestamp > quote.statusModifyTimestamp + forceCancelCooldown
	 * - Effects:
	 *   - Sets quote.quoteStatus = QuoteStatus.CANCELED.
	 *   - Updates statusModifyTimestamp.
	 *   - Releases pending locked balances for PartyA and PartyB.
	 *   - Refunds the open trading fee to PartyA’s allocated balance.
	 *   - Removes the quote from pending quotes.
	 *
	 * @param quoteId The ID of the quote to be forcibly canceled.
	 */
	function forceCancelQuote(uint256 quoteId) external;

	/**
	 * @notice Forces the cancellation of a close request on a quote when PartyB
	 *         is not responsive for at least the configured
	 *         forceCancelCloseCooldown.
	 *
	 * @dev
	 * - Only applicable to quotes in CANCEL_CLOSE_PENDING state.
	 * - Checks:
	 *   - quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING
	 *   - block.timestamp > quote.statusModifyTimestamp + forceCancelCloseCooldown
	 * - Effects:
	 *   - Sets quote.quoteStatus = QuoteStatus.OPENED.
	 *   - Resets requestedClosePrice and quantityToClose to zero.
	 *
	 * @param quoteId The ID of the quote whose close request will be canceled.
	 */
	function forceCancelCloseRequest(uint256 quoteId) external;

	/**
	 * @notice Forces the closure of the open position associated with a quote
	 *         when off-chain conditions and Muon price data justify a force close.
	 *
	 * @dev
	 * - Only valid in “normal” mode (non-master-account). Reverts if
	 *   masterAccountMode[partyB] == true.
	 * - Uses the Muon high/low price signature to:
	 *   - Verify the price band for the quote (verifyPrice).
	 *   - Compute a valid closePrice within that band
	 *     (verifyAndGetClosePrice).
	 * - Computes post-close available balances using:
	 *   LibForceActions.getAvailableBalancesAfterClose.
	 *   If PartyA’s available balance would be negative, it reverts:
	 *   ForceCloseErrors.PartyAWillBeInsolvent().
	 * - Attempts to solve the close from PartyB’s allocated + reserved
	 *   balances via solveUsingAllocatedBalances.
	 * - If not solvent, liquidates PartyB for this quote using
	 *   LibForceActions.liquidatePartyB.
	 *
	 * @param quoteId The ID of the quote whose position will be forcibly closed.
	 * @param sig Muon high/low price signature and uPNL data for PartyA/PartyB.
	 */
	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external;

	/**
	 * @notice First realizes PnL via settlement, then forces the closure of
	 *         the position associated with the specified quote in normal mode.
	 *
	 * @dev
	 * 1. Settlement phase:
	 *    - Verifies settleSig via Muon:
	 *      LibMuonSettlement.verifySettlement(settleSig, partyA).
	 *    - Realizes uPNL and updates balances via:
	 *      LibSettlement.settleUpnl(settleSig, updatedPrices, partyA, true).
	 *    - Marks forceCloseDetails[quoteId].settlementState as
	 *      UPNLSettlementState.REALIZED.
	 *
	 * 2. Force-close phase:
	 *    - Delegates to the same logic as forceClosePosition, using sig.
	 *    - Applies full force-close flow and potential PartyB liquidation.
	 *
	 * @param quoteId The ID of the quote to settle and then forcibly close.
	 * @param sig Muon high/low price signature used for the force-close phase.
	 * @param settleSig Settlement data including quoteIds, uPNLs and prices.
	 * @param updatedPrices New prices to be used for settlement of the given
	 *                      quotes in settleSig.
	 */
	function settleAndForceClosePosition(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices
	) external;

	/**
	 * @notice Initializes a force-close flow for a quote where PartyB operates
	 *         in master account mode. This prepares the system to later settle
	 *         master-account uPNL and finalize the force close.
	 *
	 * @dev
	 * - Only valid when masterAccountMode[partyB] == true. Otherwise:
	 *   ForceCloseErrors.MasterAccountModeInactive().
	 * - Uses Muon high/low price signature to:
	 *   - Validate price band (verifyPrice).
	 *   - Determine closePrice (verifyAndGetClosePrice).
	 * - Computes post-close available balances:
	 *   LibForceActions.getAvailableBalancesAfterClose.
	 *   If PartyA’s available balance would be negative, reverts:
	 *   ForceCloseErrors.PartyAWillBeInsolvent().
	 * - Stores a ForceCloseDetail for quoteId:
	 *   - timestamp
	 *   - partyBAvailableAfterClose
	 *   - closePrice
	 *   - inProgress = true
	 *
	 * @param quoteId The ID of the quote whose position is being prepared for
	 *                force close under master account mode.
	 * @param sig Muon high/low price signature and uPNL data.
	 * @return forceCloseId The identifier used for subsequent master-account
	 *                       settlement and finalization. In practice this maps
	 *                       to the same key used in forceCloseDetails.
	 */
	function initializeMasterAccountForceClose(
		uint256 quoteId,
		HighLowPriceSig memory sig
	) external returns (uint256 forceCloseId);

	/**
	 * @notice Realizes uPNL for all relevant PartyA accounts as part of a
	 *         master account force-close flow.
	 *
	 * @dev
	 * - Requires that a force-close flow for forceCloseId is already in
	 *   progress (initialized via initializeMasterAccountForceClose).
	 *   If not:
	 *   ForceCloseErrors.InvalidState().
	 * - Verifies the master-account settlement signature via:
	 *   LibMuonCrossSettlement.verifyMasterAccountSettlement(settlementSig).
	 * - Realizes uPNL and updates per-PartyA allocated balances via:
	 *   LibSettlement.settleUpnlMasterAccount(settlementSig, updatedPrices, true).
	 * - Updates forceCloseDetails[forceCloseId]:
	 *   - settlementState = UPNLSettlementState.REALIZED_MASTER_ACCOUNT
	 *   - timestamp = block.timestamp
	 *
	 * @param forceCloseId The identifier of the master-account force-close flow,
	 *                     as returned by initializeMasterAccountForceClose.
	 * @param settlementSig Settlement data for master account, including per-PartyA
	 *                      uPNLs and quote pricing.
	 * @param updatedPrices New prices to be applied for the quotes in settlementSig.
	 */
	function settleUpnlMasterAccount(
		uint256 forceCloseId,
		MasterAccountSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;

	/**
	 * @notice Finalizes a master account force-close flow after the corresponding
	 *         master-account uPNL has been realized.
	 *
	 * @dev
	 * - Only valid when masterAccountMode[partyB] == true for the PartyB of
	 *   the quote identified by forceCloseId. Otherwise:
	 *   ForceCloseErrors.MasterAccountModeInactive().
	 * - Reads ForceCloseDetail for forceCloseId and calls the internal
	 *   _forceClose with:
	 *   - the stored closePrice
	 *   - partyBAvailableAfterClose
	 *   - PartyB’s allocated balance at address(0) (master account bucket)
	 *   - zero uPNL inputs (liquidation path is disabled in master-account mode)
	 *   - isMasterAccount = true
	 * - Marks the force-close as solved or leaves it marked according to
	 *   _forceClose result.
	 *
	 * @param forceCloseId The identifier of the master-account force-close flow
	 *                     to finalize.
	 */
	function finalizeMasterAccountForceClose(uint256 forceCloseId) external;
}

/// @notice Shared custom errors for the ForceActions facet and its libraries.
/// @dev These are defined in a separate library so they can be imported and
///      reused by multiple facets / libraries without circular dependencies.
library ForceCloseErrors {
	// -----------------------------------------------------------------------------
	// Custom errors
	// -----------------------------------------------------------------------------

	/// @notice Thrown when a quote or force-close detail is in an invalid state
	///         for the attempted action (e.g., wrong quoteStatus, or the
	///         force-close flow is not marked as in-progress).
	error InvalidState();

	/// @notice Thrown when a cooldown period has not yet elapsed.
	/// Covers checks related to:
	/// - forceCancelCooldown
	/// - forceCancelCloseCooldown
	error CooldownNotReached();

	/// @notice Thrown when a force close request has exceeded its allowed time
	///         window and is considered expired.
	error CloseRequestExpired();

	/// @notice Thrown when a quote's order type is not LIMIT as required by
	///         the force-close logic.
	error InvalidOrderType();

	/// @notice Thrown when the supplied average price is outside the permitted
	///         high/low bounds encoded in the Muon signature.
	error InvalidAveragePrice();

	/// @notice Thrown when the requested close price has not been reached within
	///         the required gap ratio threshold derived from risk parameters.
	error RequestedClosePriceNotReached();

	/// @notice Thrown when the signature period for a force close is too short,
	///         i.e. the high/low time window does not satisfy configured limits.
	error InvalidSignaturePeriod();

	/// @notice Thrown when applying the force-close would make PartyA’s available
	///         balance negative (i.e. PartyA would become insolvent).
	error PartyAWillBeInsolvent();

	/// @notice Thrown when an action that requires PartyB to be in master account
	///         mode is called while masterAccountMode[partyB] == false.
	error MasterAccountModeInactive();

	/// @notice Thrown when an action references a quote that does not belong to
	///         the expected PartyB or otherwise fails identity validation.
	error InvalidQuote();

	/// @notice Thrown when an action that is only valid in normal mode is called
	///         while PartyB’s masterAccountMode is enabled.
	error MasterAccountModeEnabled();
}
