// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { WithdrawInfo } from "../types/WithdrawTypes.sol";

import { ICreditLineManager } from "../interfaces/ICreditLineManager.sol";
import { ISymmio } from "../interfaces/ISymmio.sol";

import { ExpressProviderStorage } from "../storages/ExpressProviderStorage.sol";

/// @title LibCreditLine
/// @notice Shared credit line helpers used by SymmioHookFacet and OperatorFacet.
library LibCreditLine {
	/// @dev Activates reserved credit and advances collateral from core.
	///      No-op if creditAmount == 0.
	function activate(address symmio, address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		ICreditLineManager(info.creditLineManager).activateDebt(user, requestId);
		ISymmio(symmio).advanceWithdraw(user, requestId, info.creditAmount);
	}

	/// @dev Settles active credit debt after finalization. No-op if creditAmount == 0.
	function settle(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		ICreditLineManager(info.creditLineManager).settleDebt(user, requestId);
	}

	/// @dev Releases reserved credit on cancel/suspend before payout. No-op if creditAmount == 0.
	function releaseReservation(address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;
		ICreditLineManager(info.creditLineManager).cancelReservation(user, requestId);
	}

	/// @dev Covers credit loss on post-payout rollback (suspend/force-cancel after PROCESSED).
	///      Deducts from affiliate pool and settles credit debt.
	///      Note: core's forceCancelWithdraw requires block.timestamp < cooldownEndTime,
	///      so this path cannot be triggered for PROCESSED express withdrawals in practice.
	function coverLoss(IERC20 collateral, address symmio, address user, uint256 requestId, WithdrawInfo storage info) internal {
		if (info.creditAmount == 0) return;

		ExpressProviderStorage.Layout storage s = ExpressProviderStorage.layout();
		s.affiliateBalances[info.affiliate] -= info.creditAmount;

		ICreditLineManager(info.creditLineManager).settleDebt(user, requestId);
	}
}
