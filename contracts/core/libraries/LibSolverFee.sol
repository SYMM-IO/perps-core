// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, SolverFeeCaps, SolverFeeState } from "../storages/QuoteStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibAccount } from "./LibAccount.sol";

library LibSolverFee {
	/// @notice Charges an open solver fee if the amount is nonzero.
	/// @return receiver The account credited with the fee, or the account that would be credited when `solverFee` is zero.
	function chargeOpenFeeIfAny(uint256 quoteId, uint256 solverFee) internal returns (address receiver) {
		if (solverFee > 0) {
			return chargeOpenSolverFee(quoteId, solverFee);
		}
		return LibAccount.getSolverFeeReceiver(QuoteStorage.layout().quotes[quoteId].partyB);
	}

	/// @notice Charges a close solver fee if the amount is nonzero. Must be called BEFORE the close itself executes: a final close can fire
	///         hooks (e.g. AccountLayer virtual-account cleanup) that deallocate PartyA's entire allocated
	///         balance, which would make a post-close fee charge revert.
	/// @param fillAmount The amount about to be closed (not yet reflected in quote.closedAmount).
	/// @param fillPrice The price the fill amount will be closed at.
	/// @return receiver The account credited with the fee, or the account that would be credited when `solverFee` is zero.
	function chargeCloseFeeIfAny(uint256 quoteId, uint256 solverFee, uint256 fillAmount, uint256 fillPrice) internal returns (address receiver) {
		if (solverFee > 0) {
			return chargeCloseSolverFee(quoteId, solverFee, fillAmount, fillPrice);
		}
		return LibAccount.getSolverFeeReceiver(QuoteStorage.layout().quotes[quoteId].partyB);
	}

	function caps(SolverFeeState storage feeState) internal view returns (SolverFeeCaps memory) {
		return SolverFeeCaps({ openRateCap: feeState.openRateCap, closeRateCap: feeState.closeRateCap });
	}

	/// @notice Charges a capped open solver fee from PartyA allocated balance into the PartyB's solver fee receiver.
	/// @return receiver The account credited with the fee (the PartyB itself unless it configured a receiver).
	function chargeOpenSolverFee(uint256 quoteId, uint256 amount) internal returns (address receiver) {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.initialOpenedPrice > 0, "SolverFee: Quote is not opened");

		uint256 notional = (quote.quantity * quote.initialOpenedPrice) / 1e18;
		feeState.openFeeCharged += amount;
		require(feeState.openFeeCharged <= (notional * feeState.openRateCap) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		receiver = _collectSolverFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.OPEN_SOLVER_FEE_OUT);
	}

	/// @notice Charges a capped close solver fee from PartyA allocated balance into the PartyB's solver fee receiver.
	/// @dev The rate cap is enforced against the cumulative closed notional including the pending fill,
	///      since this is called before the close itself updates quote.closedAmount/avgClosedPrice.
	/// @return receiver The account credited with the fee (the PartyB itself unless it configured a receiver).
	function chargeCloseSolverFee(uint256 quoteId, uint256 amount, uint256 fillAmount, uint256 fillPrice) internal returns (address receiver) {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.closedAmount + fillAmount > 0, "SolverFee: Quote is not closed");

		uint256 notional = (quote.closedAmount * quote.avgClosedPrice + fillAmount * fillPrice) / 1e18;
		feeState.closeFeeCharged += amount;
		require(feeState.closeFeeCharged <= (notional * feeState.closeRateCap) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		receiver = _collectSolverFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.CLOSE_SOLVER_FEE_OUT);
	}

	/// @dev Credits the PartyB's configured solver fee receiver, defaulting to the PartyB itself.
	///      The receiver is resolved at charge time, so a receiver change only affects subsequent fees.
	function _collectSolverFee(
		address partyA,
		address partyB,
		uint256 amount,
		SharedEvents.BalanceChangeType changeType
	) private returns (address receiver) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		receiver = LibAccount.getSolverFeeReceiver(partyB);
		// Routing the fee back to PartyA would move allocated balance into free balance without setting
		// deallocateTimestamp, sidestepping the withdraw cooldown. Mirrors the operational fee payer guard.
		require(receiver != partyA, "SolverFee: Receiver is partyA");
		require(accountLayout.allocatedBalances[partyA] >= amount, "SolverFee: Insufficient allocated balance");
		LibAccount.decreasePartyAAllocatedBalance(partyA, amount, changeType);
		accountLayout.balances[receiver] += amount;
	}
}
