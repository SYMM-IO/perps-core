// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { PledgeStorage, PledgeWithdrawalRequest, PledgeWithdrawStatus } from "../../storages/PledgeStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";

library PledgeFacetImpl {
	/// @notice Deposits pledge collateral for the caller
	function depositPledge(uint256 amount, address token) internal {
		PledgeStorage.Layout storage pledgeLayout = PledgeStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");

		LibSafeERC20.safeTransferFrom(token, signer, address(this), amount);
		pledgeLayout.pledgeDeposit[signer][token] += amount;
	}

	/// @notice Creates a withdrawal request for pledge collateral
	function requestPledgeWithdraw(uint256 amount, address token, address recipient) internal {
		PledgeStorage.Layout storage pledgeLayout = PledgeStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");
		require(recipient != address(0), "AccountFacet: invalid recipient");
		require(pledgeLayout.pledgeWithdrawalRequests[signer].status == PledgeWithdrawStatus.NONE, "AccountFacet: withdraw pending");
		require(pledgeLayout.pledgeDeposit[signer][token] >= amount, "AccountFacet: insufficient Pledge collateral");

		pledgeLayout.pledgeWithdrawalRequests[signer] = PledgeWithdrawalRequest({
			token: token,
			amount: amount,
			recipient: recipient,
			requester: signer,
			status: PledgeWithdrawStatus.PENDING
		});
	}

	/// @notice Accepts a pending pledge withdrawal request and transfers tokens to the recipient
	function acceptPledgeWithdraw(address user, uint256 amount, address token) internal {
		PledgeStorage.Layout storage pledgeLayout = PledgeStorage.layout();
		PledgeWithdrawalRequest storage req = pledgeLayout.pledgeWithdrawalRequests[user];

		require(req.status == PledgeWithdrawStatus.PENDING, "AccountFacet: no pending Pledge withdraw");
		require(req.requester == user, "AccountFacet: requester mismatch");
		require(req.token == token && req.amount >= amount, "AccountFacet: params mismatch");
		require(pledgeLayout.pledgeDeposit[user][token] >= amount, "AccountFacet: insufficient Pledge collateral");

		address recipient = req.recipient;
		pledgeLayout.pledgeDeposit[user][token] -= amount;
		delete pledgeLayout.pledgeWithdrawalRequests[user];

		LibSafeERC20.safeTransfer(token, recipient, amount);
	}

	/// @notice Cancels the caller's pending pledge withdrawal request
	function cancelPledgeWithdraw() internal returns (address token, uint256 amount) {
		PledgeStorage.Layout storage pledgeLayout = PledgeStorage.layout();
		address signer = LibSigner.getSigner();
		PledgeWithdrawalRequest storage req = pledgeLayout.pledgeWithdrawalRequests[signer];

		require(req.status == PledgeWithdrawStatus.PENDING, "AccountFacet: no pending Pledge withdraw");

		token = req.token;
		amount = req.amount;
		delete pledgeLayout.pledgeWithdrawalRequests[signer];
	}

	/// @notice Slashes a user's pledge collateral and transfers the penalty to a recipient
	function slashPledge(address user, address token, uint256 amount, address recipient) internal {
		PledgeStorage.Layout storage pledgeLayout = PledgeStorage.layout();

		require(amount > 0, "AccountFacet: invalid penalty");
		require(pledgeLayout.pledgeDeposit[user][token] >= amount, "AccountFacet: insufficient Pledge collateral");

		pledgeLayout.pledgeDeposit[user][token] -= amount;
		LibSafeERC20.safeTransfer(token, recipient, amount);
	}
}
