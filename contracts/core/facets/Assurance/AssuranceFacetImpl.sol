// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { AccountStorage, AssuranceWithdrawalRequest, AssuranceWithdrawStatus } from "../../storages/AccountStorage.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibSafeERC20 } from "../../libraries/LibSafeERC20.sol";

library AssuranceFacetImpl {
	function depositAssuranceCollateral(uint256 amount, address token) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");

		LibSafeERC20.safeTransferFrom(token, signer, address(this), amount);
		accountLayout.assuranceCollateral[signer][token] += amount;
	}

	function requestAssuranceWithdraw(uint256 amount, address token, address recipient) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();

		require(amount > 0, "AccountFacet: invalid amount");
		require(recipient != address(0), "AccountFacet: invalid recipient");
		require(accountLayout.assuranceWithdrawalRequests[signer].status == AssuranceWithdrawStatus.NONE, "AccountFacet: withdraw pending");
		require(accountLayout.assuranceCollateral[signer][token] >= amount, "AccountFacet: insufficient Assurance collateral");

		accountLayout.assuranceWithdrawalRequests[signer] = AssuranceWithdrawalRequest({
			token: token,
			amount: amount,
			recipient: recipient,
			requester: signer,
			status: AssuranceWithdrawStatus.PENDING
		});
	}

	function acceptAssuranceWithdraw(address user, uint256 amount, address token) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		AssuranceWithdrawalRequest storage req = accountLayout.assuranceWithdrawalRequests[user];

		require(req.status == AssuranceWithdrawStatus.PENDING, "AccountFacet: no pending Assurance withdraw");
		require(req.requester == user, "AccountFacet: requester mismatch");
		require(req.token == token && req.amount >= amount, "AccountFacet: params mismatch");
		require(accountLayout.assuranceCollateral[user][token] >= amount, "AccountFacet: insufficient Assurance collateral");

		address recipient = req.recipient;
		accountLayout.assuranceCollateral[user][token] -= amount;
		delete accountLayout.assuranceWithdrawalRequests[user];

		LibSafeERC20.safeTransfer(token, recipient, amount);
	}

	function cancelAssuranceWithdraw() internal returns (address token, uint256 amount) {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();
		address signer = LibSigner.getSigner();
		AssuranceWithdrawalRequest storage req = accountLayout.assuranceWithdrawalRequests[signer];

		require(req.status == AssuranceWithdrawStatus.PENDING, "AccountFacet: no pending Assurance withdraw");

		token = req.token;
		amount = req.amount;
		delete accountLayout.assuranceWithdrawalRequests[signer];
	}

	function slashUser(address user, address token, uint256 amount, address recipient) internal {
		AccountStorage.Layout storage accountLayout = AccountStorage.layout();

		require(amount > 0, "AccountFacet: invalid penalty");
		require(accountLayout.assuranceCollateral[user][token] >= amount, "AccountFacet: insufficient Assurance collateral");

		accountLayout.assuranceCollateral[user][token] -= amount;
		LibSafeERC20.safeTransfer(token, recipient, amount);
	}
}
