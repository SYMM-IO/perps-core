// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, SolverFeeCaps, SolverFeeState } from "../storages/QuoteStorage.sol";
import { LibAccount } from "./LibAccount.sol";
import { SharedEvents } from "./SharedEvents.sol";

library LibSolverFee {
	function chargeOpenFees(uint256 quoteId, uint256 operationalFee, uint256 solverFee) internal {
		if (operationalFee > 0) {
			chargeOperationalFee(quoteId, operationalFee);
		}
		if (solverFee > 0) {
			chargeOpenSolverFee(quoteId, solverFee);
		}
	}

	/// @notice Charges close fees. Must be called BEFORE the close itself executes: a final close can fire
	///         hooks (e.g. AccountLayer virtual-account cleanup) that deallocate PartyA's entire allocated
	///         balance, which would make a post-close fee charge revert.
	/// @param pendingFilledAmount The amount about to be closed (not yet reflected in quote.closedAmount).
	/// @param pendingClosedPrice The price the pending amount will be closed at.
	function chargeCloseFees(
		uint256 quoteId,
		uint256 operationalFee,
		uint256 solverFee,
		uint256 pendingFilledAmount,
		uint256 pendingClosedPrice
	) internal {
		if (operationalFee > 0) {
			chargeOperationalFee(quoteId, operationalFee);
		}
		if (solverFee > 0) {
			chargeCloseSolverFee(quoteId, solverFee, pendingFilledAmount, pendingClosedPrice);
		}
	}

	function caps(SolverFeeState storage feeState) internal view returns (SolverFeeCaps memory) {
		return
			SolverFeeCaps({
				maxOperationalFee: feeState.maxOperationalFee,
				maxOpenSolverFeeRate: feeState.maxOpenSolverFeeRate,
				maxCloseSolverFeeRate: feeState.maxCloseSolverFeeRate
			});
	}

	/// @notice Charges a capped operational fee from PartyA allocated balance into PartyB free balance.
	function chargeOperationalFee(uint256 quoteId, uint256 amount) internal returns (address receiver) {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];

		feeState.chargedOperationalFee += amount;
		require(feeState.chargedOperationalFee <= feeState.maxOperationalFee, "SolverFee: Operational fee cap exceeded");
		receiver = LibAccount.getOperationalFeeReceiver(quote.partyB);
		_transferFee(quote.partyA, receiver, amount, SharedEvents.BalanceChangeType.OPERATIONAL_FEE_OUT);
	}

	/// @notice Charges a capped open solver fee from PartyA allocated balance into PartyB free balance.
	function chargeOpenSolverFee(uint256 quoteId, uint256 amount) internal {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.initialOpenedPrice > 0, "SolverFee: Quote is not opened");

		uint256 notional = (quote.quantity * quote.initialOpenedPrice) / 1e18;
		feeState.chargedOpenSolverFee += amount;
		require(feeState.chargedOpenSolverFee <= (notional * feeState.maxOpenSolverFeeRate) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		_transferFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.OPEN_SOLVER_FEE_OUT);
	}

	/// @notice Charges a capped close solver fee from PartyA allocated balance into PartyB free balance.
	/// @dev The rate cap is enforced against the cumulative closed notional including the pending fill,
	///      since this is called before the close itself updates quote.closedAmount/avgClosedPrice.
	function chargeCloseSolverFee(uint256 quoteId, uint256 amount, uint256 pendingFilledAmount, uint256 pendingClosedPrice) internal {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		require(quote.closedAmount + pendingFilledAmount > 0, "SolverFee: Quote is not closed");

		uint256 notional = (quote.closedAmount * quote.avgClosedPrice + pendingFilledAmount * pendingClosedPrice) / 1e18;
		feeState.chargedCloseSolverFee += amount;
		require(feeState.chargedCloseSolverFee <= (notional * feeState.maxCloseSolverFeeRate) / 1e18, "SolverFee: Solver fee rate cap exceeded");
		_transferFee(quote.partyA, quote.partyB, amount, SharedEvents.BalanceChangeType.CLOSE_SOLVER_FEE_OUT);
	}

	function _transferFee(address partyA, address receiver, uint256 amount, SharedEvents.BalanceChangeType changeType) private {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		require(accountLayout.allocatedBalances[partyA] >= amount, "SolverFee: Insufficient allocated balance");
		accountLayout.allocatedBalances[partyA] -= amount;
		emit SharedEvents.BalanceChangePartyA(partyA, amount, changeType);
		accountLayout.balances[receiver] += amount;
	}
}
