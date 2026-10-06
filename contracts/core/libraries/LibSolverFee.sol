// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, SolverFeeCaps, SolverFeeEntry, SolverFeeState } from "../storages/QuoteStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibAccount } from "./LibAccount.sol";

library LibSolverFee {
	function caps(SolverFeeState storage feeState) internal view returns (SolverFeeCaps memory) {
		return SolverFeeCaps({ openRateCap: feeState.openRateCap, closeRateCap: feeState.closeRateCap });
	}

	/// @notice Charges tagged OPEN solver fees against the quote's cumulative opened-notional cap.
	/// @dev Called after the position opens, so `initialOpenedPrice` is the notional basis. Suspended
	///      Party A accounts cannot be charged. Each entry routes to the receiver resolved for its tag.
	function chargeOpenSolverFees(uint256 quoteId, SolverFeeEntry[] calldata entries) internal returns (address[] memory receivers) {
		uint256 totalAmount = _validateFees(entries);

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		require(!AccountStorage.layout().suspendedAddresses[quote.partyA], "SolverFee: Payer suspended");
		require(quote.initialOpenedPrice > 0, "SolverFee: Quote is not opened");

		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		uint256 openNotional = Math.mulDiv(quote.quantity, quote.initialOpenedPrice, 1e18);
		feeState.openFeeCharged += totalAmount;
		require(feeState.openFeeCharged <= Math.mulDiv(openNotional, feeState.openRateCap, 1e18), "SolverFee: Solver fee rate cap exceeded");

		receivers = _collectSolverFees(quote, entries, SharedEvents.BalanceChangeType.OPEN_SOLVER_FEE_OUT);
	}

	/// @notice Charges tagged CLOSE solver fees against the quote's cumulative closed-notional cap.
	/// @dev Must be called BEFORE the close itself executes: a final close can fire hooks (e.g. AccountLayer
	///      virtual-account cleanup) that deallocate PartyA's entire allocated balance, which would make a
	///      post-close fee charge revert. The cap basis therefore includes the pending fill, which is not yet
	///      reflected in quote.closedAmount/avgClosedPrice. Suspended Party A accounts cannot be charged.
	/// @param fillAmount The amount about to be closed.
	/// @param fillPrice The price the fill amount will be closed at.
	function chargeCloseSolverFees(
		uint256 quoteId,
		SolverFeeEntry[] memory entries,
		uint256 fillAmount,
		uint256 fillPrice
	) internal returns (address[] memory receivers) {
		uint256 totalAmount = _validateFees(entries);

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		require(!AccountStorage.layout().suspendedAddresses[quote.partyA], "SolverFee: Payer suspended");
		require(quote.closedAmount + fillAmount > 0, "SolverFee: Quote is not closed");

		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		uint256 closedNotional = (quote.closedAmount * quote.avgClosedPrice + fillAmount * fillPrice) / 1e18;
		feeState.closeFeeCharged += totalAmount;
		require(feeState.closeFeeCharged <= Math.mulDiv(closedNotional, feeState.closeRateCap, 1e18), "SolverFee: Solver fee rate cap exceeded");

		receivers = _collectSolverFees(quote, entries, SharedEvents.BalanceChangeType.CLOSE_SOLVER_FEE_OUT);
	}

	/// @dev Every entry must carry a positive amount; the list must be non-empty.
	function _validateFees(SolverFeeEntry[] memory entries) private pure returns (uint256 totalAmount) {
		require(entries.length > 0, "SolverFee: Empty fee list");
		for (uint256 i = 0; i < entries.length; i++) {
			require(entries[i].amount > 0, "SolverFee: Zero amount");
			totalAmount += entries[i].amount;
		}
	}

	function _collectSolverFees(
		Quote storage quote,
		SolverFeeEntry[] memory entries,
		SharedEvents.BalanceChangeType changeType
	) private returns (address[] memory receivers) {
		receivers = new address[](entries.length);
		for (uint256 i = 0; i < entries.length; i++) {
			receivers[i] = _collectSolverFee(quote.partyA, quote.partyB, entries[i].amount, entries[i].tag, changeType);
		}
	}

	/// @dev Credits the tag-specific receiver, then the default receiver, then the Party B itself.
	///      The receiver is resolved at charge time, so configuration changes affect only subsequent fees.
	function _collectSolverFee(
		address partyA,
		address partyB,
		uint256 amount,
		bytes32 tag,
		SharedEvents.BalanceChangeType changeType
	) private returns (address receiver) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		receiver = LibAccount.getSolverFeeReceiver(partyB, tag);
		// Routing the fee back to PartyA would move allocated balance into free balance without setting
		// deallocateTimestamp, sidestepping the withdraw cooldown. Mirrors the operational fee payer guard.
		require(receiver != partyA, "SolverFee: Receiver is partyA");
		require(accountLayout.allocatedBalances[partyA] >= amount, "SolverFee: Insufficient allocated balance");
		LibAccount.decreasePartyAAllocatedBalance(partyA, amount, changeType);
		accountLayout.balances[receiver] += amount;
	}
}
