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
	function chargeOpenFeeIfAny(uint256 quoteId, uint256 solverFee) internal {
		if (solverFee > 0) {
			chargeOpenSolverFee(quoteId, solverFee);
		}
	}

	/// @notice Charges a close solver fee if the amount is nonzero. Must be called BEFORE the close itself executes: a final close can fire
	///         hooks (e.g. AccountLayer virtual-account cleanup) that deallocate PartyA's entire allocated
	///         balance, which would make a post-close fee charge revert.
	/// @param fillAmount The amount about to be closed (not yet reflected in quote.closedAmount).
	/// @param fillPrice The price the fill amount will be closed at.
	function chargeCloseFeeIfAny(uint256 quoteId, uint256 solverFee, uint256 fillAmount, uint256 fillPrice) internal {
		if (solverFee > 0) {
			chargeCloseSolverFee(quoteId, solverFee, fillAmount, fillPrice);
		}
	}

	function caps(SolverFeeState storage feeState) internal view returns (SolverFeeCaps memory) {
		return SolverFeeCaps({ openRateCap: feeState.openRateCap, closeRateCap: feeState.closeRateCap });
	}

	/// @notice Charges a capped open solver fee from PartyA allocated balance into PartyB free balance.
	function chargeOpenSolverFee(uint256 quoteId, uint256 amount) internal {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.initialOpenedPrice > 0, "SolverFee: Quote is not opened");

		uint256 notional = (quote.quantity * quote.initialOpenedPrice) / 1e18;
		feeState.openFeeCharged += amount;
		require(feeState.openFeeCharged <= (notional * feeState.openRateCap) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		_collectSolverFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.OPEN_SOLVER_FEE_OUT);
	}

	/// @notice Charges a capped close solver fee from PartyA allocated balance into PartyB free balance.
	/// @dev The rate cap is enforced against the cumulative closed notional including the pending fill,
	///      since this is called before the close itself updates quote.closedAmount/avgClosedPrice.
	function chargeCloseSolverFee(uint256 quoteId, uint256 amount, uint256 fillAmount, uint256 fillPrice) internal {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.closedAmount + fillAmount > 0, "SolverFee: Quote is not closed");

		uint256 notional = (quote.closedAmount * quote.avgClosedPrice + fillAmount * fillPrice) / 1e18;
		feeState.closeFeeCharged += amount;
		require(feeState.closeFeeCharged <= (notional * feeState.closeRateCap) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		_collectSolverFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.CLOSE_SOLVER_FEE_OUT);
	}

	function _collectSolverFee(address partyA, address receiver, uint256 amount, SharedEvents.BalanceChangeType changeType) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.allocatedBalances[partyA] >= amount, "SolverFee: Insufficient allocated balance");
		LibAccount.decreasePartyAAllocatedBalance(partyA, amount, changeType);
		accountLayout.balances[receiver] += amount;
	}
}
