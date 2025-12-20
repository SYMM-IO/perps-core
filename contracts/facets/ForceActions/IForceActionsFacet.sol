// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./ForceActionsFacetEvents.sol";

/// @title ForceActionsFacet Interface
/// @notice Defines the user-side (PartyA) force-action workflows that apply when
///         PartyB becomes unresponsive or when solvency logic requires the system
///         to close or cancel quotes/positions.
/// @dev The logic is implemented in ForceActionsFacet + ForceActionsFacetImpl.

interface IForceActionsFacet is ForceActionsFacetEvents {
	/**
	 * @notice Force-cancels a quote when PartyB is unresponsive past the
	 *         forceCancelCooldown.
	 *
	 * @dev Requirements:
	 * - Quote must be in CANCEL_PENDING state.
	 * - Current time must exceed:
	 *     quote.statusModifyTimestamp + forceCancelCooldown
	 *
	 * Effects:
	 * - Sets quoteStatus = CANCELED.
	 * - Updates statusModifyTimestamp.
	 * - Releases PartyA and PartyB pending locked balances.
	 * - Returns the open-trading fee to PartyA’s allocated balance.
	 * - Removes the quote from the pending-quotes list.
	 *
	 * @param quoteId The ID of the quote to cancel.
	 */
	function forceCancelQuote(uint256 quoteId) external;

	/**
	 * @notice Force-cancels a pending close request when PartyB is unresponsive
	 *         past the forceCancelCloseCooldown.
	 *
	 * @dev Requirements:
	 * - Quote must be in CANCEL_CLOSE_PENDING.
	 * - Current time must exceed:
	 *     quote.statusModifyTimestamp + forceCancelCloseCooldown
	 *
	 * Effects:
	 * - Sets quoteStatus = OPENED.
	 * - Resets requestedClosePrice and quantityToClose.
	 *
	 * @param quoteId The ID of the quote whose close request should be canceled.
	 */
	function forceCancelCloseRequest(uint256 quoteId) external;

	/**
	 * @notice Forces the closure of an open position when Muon high-/low-price
	 *         data validates a force-close condition.
	 *
	 * @dev Valid only in normal mode (PartyB must NOT be in master-account mode).
	 *
	 * Flow:
	 * - verifyPrice(sig) checks Muon price band for safety.
	 * - closePrice = verifyAndGetClosePrice(sig) computes a valid execution price.
	 * - getAvailableBalancesAfterClose calculates the resulting balances if closed.
	 *   Reverts if PartyA would become insolvent.
	 * - solveUsingAllocatedBalances attempts to settle using PartyB’s allocated
	 *   + reserved balances.
	 * - If insufficient, PartyB is liquidated for this quote.
	 *
	 * @param quoteId The ID of the quote whose position is being forcibly closed.
	 * @param sig Muon price band signature + uPNL information.
	 */
	function forceClosePosition(uint256 quoteId, HighLowPriceSig memory sig) external;

	/**
	 * @notice Realizes PnL via settlement, then performs a force-close on the
	 *         corresponding quote.
	 *
	 * @dev Phase 1 — Settlement:
	 * - Verifies settlementSig via LibMuonSettlement.verifySettlement.
	 * - Realizes uPNL and updates balances using LibSettlement.settleUpnl.
	 * - Marks settlementState = UPNLSettlementState.REALIZED.
	 *
	 * Phase 2 — Force Close:
	 * - Executes the same rules and logic as forceClosePosition().
	 * - May liquidate PartyB if insolvent.
	 *
	 * @param quoteId The quote to settle and then force-close.
	 * @param sig High/low price data used during the force-close phase.
	 * @param settleSig Settlement details including uPNLs and price snapshots.
	 * @param updatedPrices Prices applied during the settlement step.
	 */
	function settleAndForceClosePosition(
		uint256 quoteId,
		HighLowPriceSig memory sig,
		SettlementSig memory settleSig,
		uint256[] memory updatedPrices
	) external;

	/**
	 * @notice Begins a force-close workflow for a quote owned by a PartyB that
	 *         operates in master-account mode.
	 *
	 * @dev Requirements:
	 * - masterAccountMode[partyB] must be true.
	 *
	 * Flow:
	 * - verifyPrice(sig) validates the Muon price band.
	 * - closePrice = verifyAndGetClosePrice(sig) determines the execution price.
	 * - getAvailableBalancesAfterClose computes solvency after close.
	 *   Reverts if PartyA would become insolvent.
	 *
	 * Effects:
	 * - Saves ForceCloseDetail:
	 *   - timestamp
	 *   - partyBAvailableAfterClose
	 *   - closePrice
	 *   - inProgress = true
	 *
	 * @param quoteId The quote to prepare for force-close.
	 * @param sig Muon price band + uPNL information.
	 */
	function initializeMasterAccountForceClose(uint256 quoteId, HighLowPriceSig memory sig)
		external;

	/**
	 * @notice Realizes uPNL for all PartyA accounts connected to a master-account
	 *         force-close workflow.
	 *
	 * @dev Requirements:
	 * - The workflow must already be initialized (inProgress = true).
	 *
	 * Flow:
	 * - verifyMasterAccountSettlement(settlementSig) validates Muon signature.
	 * - settleUpnlMasterAccount(...) realizes per-PartyA uPNLs and updates
	 *   allocated balances.
	 *
	 * Effects:
	 * - Updates settlementState = UPNLSettlementState.REALIZED_MASTER_ACCOUNT.
	 * - Updates timestamp.
	 *
	 * @param forceCloseId Same as quoteId for the force-close workflow.
	 * @param settlementSig Master-account settlement data (uPNLs + pricing).
	 * @param updatedPrices Prices applied during master-account settlement.
	 */
	function settleUpnlMasterAccount(
		uint256 forceCloseId,
		MasterAccountSettlementSig memory settlementSig,
		uint256[] memory updatedPrices
	) external;

	/**
	 * @notice Finalizes a master-account force-close after its uPNL settlement
	 *         has been completed.
	 *
	 * @dev Requirements:
	 * - masterAccountMode[partyB] must still be true.
	 *
	 * Flow:
	 * - Reads ForceCloseDetail for forceCloseId.
	 * - Calls internal force-close execution using:
	 *   - stored closePrice
	 *   - partyBAvailableAfterClose
	 *   - PartyB’s master-account allocated balance (address(0))
	 *   - zero uPNL inputs (no liquidation path in master-account mode)
	 *
	 * Effects:
	 * - Marks the workflow as solved or insolvent based on outcome.
	 *
	 * @param forceCloseId Same as quoteId for the force-close workflow.
	 */
	function finalizeMasterAccountForceClose(uint256 forceCloseId) external;
}
