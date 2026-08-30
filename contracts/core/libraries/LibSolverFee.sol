// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { AccountStorage } from "../storages/AccountStorage.sol";
import { QuoteStorage, Quote, QuoteStatus, SolverFeeCaps, SolverFeeState, SolverFeeType } from "../storages/QuoteStorage.sol";
import { SharedEvents } from "./SharedEvents.sol";
import { LibAccount } from "./LibAccount.sol";

library LibSolverFee {
	function caps(SolverFeeState storage feeState) internal view returns (SolverFeeCaps memory) {
		return SolverFeeCaps({ openRateCap: feeState.openRateCap, closeRateCap: feeState.closeRateCap });
	}

	/// @notice Charges a standalone solver fee against the quote's open or close notional cap.
	/// @dev CLOSE uses only the live close request notional and must be charged before that request is filled.
	function chargeSolverFee(uint256 quoteId, SolverFeeType feeType, uint256 amount, bytes32 tagHash) internal returns (address receiver) {
		require(amount > 0, "SolverFee: Zero amount");

		QuoteStorage.Layout storage quoteLayout = QuoteStorage.layout();
		Quote storage quote = quoteLayout.quotes[quoteId];
		SolverFeeState storage feeState = quoteLayout.solverFeeStates[quoteId];
		SharedEvents.BalanceChangeType changeType;

		if (feeType == SolverFeeType.OPEN) {
			require(quote.initialOpenedPrice > 0, "SolverFee: Quote is not opened");
			uint256 openNotional = Math.mulDiv(quote.quantity, quote.initialOpenedPrice, 1e18);
			feeState.openFeeCharged += amount;
			require(feeState.openFeeCharged <= Math.mulDiv(openNotional, feeState.openRateCap, 1e18), "SolverFee: Solver fee rate cap exceeded");
			changeType = SharedEvents.BalanceChangeType.OPEN_SOLVER_FEE_OUT;
		} else {
			require(
				quote.quoteStatus == QuoteStatus.CLOSE_PENDING || quote.quoteStatus == QuoteStatus.CANCEL_CLOSE_PENDING,
				"SolverFee: No pending close request"
			);
			uint256 closeNotional = Math.mulDiv(quote.quantityToClose, quote.requestedClosePrice, 1e18);
			uint256 closeId = quoteLayout.closeIds[quoteId];
			uint256 requestFeeCharged = quoteLayout.closeRequestSolverFeeCharged[closeId] + amount;
			require(requestFeeCharged <= Math.mulDiv(closeNotional, feeState.closeRateCap, 1e18), "SolverFee: Solver fee rate cap exceeded");
			quoteLayout.closeRequestSolverFeeCharged[closeId] = requestFeeCharged;
			feeState.closeFeeCharged += amount;
			changeType = SharedEvents.BalanceChangeType.CLOSE_SOLVER_FEE_OUT;
		}

		receiver = _collectSolverFee(quote.partyA, quote.partyB, amount, tagHash, changeType);
	}

	/// @dev Credits the tag-specific receiver, then the default receiver, then the Party B itself.
	///      The receiver is resolved at charge time, so configuration changes affect only subsequent fees.
	function _collectSolverFee(
		address partyA,
		address partyB,
		uint256 amount,
		bytes32 tagHash,
		SharedEvents.BalanceChangeType changeType
	) private returns (address receiver) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		receiver = LibAccount.getSolverFeeReceiver(partyB, tagHash);
		// Routing the fee back to PartyA would move allocated balance into free balance without setting
		// deallocateTimestamp, sidestepping the withdraw cooldown. Mirrors the operational fee payer guard.
		require(receiver != partyA, "SolverFee: Receiver is partyA");
		require(accountLayout.allocatedBalances[partyA] >= amount, "SolverFee: Insufficient allocated balance");
		LibAccount.decreasePartyAAllocatedBalance(partyA, amount, changeType);
		accountLayout.balances[receiver] += amount;
	}
}
