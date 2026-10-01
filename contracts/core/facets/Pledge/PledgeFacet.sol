// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IPledgeFacet } from "./IPledgeFacet.sol";
import { PledgeFacetImpl } from "./PledgeFacetImpl.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";
import { PledgeStorage } from "../../storages/PledgeStorage.sol";

contract PledgeFacet is Accessibility, Pausable, IPledgeFacet {
	/// @notice Allows or disallows a token for new pledge deposits.
	/// @dev Managers must review token behavior off-chain: deposits credit the requested amount,
	///      with no transfer-fee or rebase adjustment. Removal does not restrict withdrawals or slashing.
	function setPledgeTokenWhitelist(address token, bool whitelisted) external onlyRole(LibAccessibility.PLEDGE_TOKEN_MANAGER_ROLE) {
		require(token != address(0), "PledgeFacet: Zero address");
		require(!whitelisted || token.code.length > 0, "PledgeFacet: Token has no code");
		PledgeStorage.layout().whitelistedTokens[token] = whitelisted;
		emit PledgeTokenWhitelistUpdated(token, whitelisted);
	}

	/// @notice Returns whether a token is allowed for new pledge deposits.
	function isPledgeTokenWhitelisted(address token) external view returns (bool) {
		return PledgeStorage.layout().whitelistedTokens[token];
	}

	/// @notice Deposit pledge collateral for the caller.
	/// @param token ERC20 token to deposit (token decimals, not normalized).
	/// @param amount Amount to deposit.
	function depositPledge(address token, uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		PledgeFacetImpl.depositPledge(amount, token);
		emit PledgeCollateralDeposited(signer, token, amount);
	}

	/// @notice Request to withdraw pledge to a specific recipient.
	/// @param token ERC20 token to withdraw.
	/// @param amount Amount to withdraw.
	/// @param recipient Address receiving the withdrawal if approved.
	function requestPledgeWithdraw(
		address token,
		uint256 amount,
		address recipient
	) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		PledgeFacetImpl.requestPledgeWithdraw(amount, token, recipient);
		emit PledgeWithdrawRequested(LibSigner.getSigner(), token, amount, recipient);
	}

	/// @notice Cancel a pending pledge withdrawal request.
	function cancelPledgeWithdraw() external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		(address token, uint256 amount) = PledgeFacetImpl.cancelPledgeWithdraw();
		emit PledgeWithdrawCancelled(LibSigner.getSigner(), token, amount);
	}

	/// @notice Approve a pending pledge withdrawal and transfer funds to the requested recipient.
	/// @param user User whose request is being approved.
	/// @param amount Amount to withdraw.
	/// @param token ERC20 token to withdraw.
	function acceptPledgeWithdraw(
		address user,
		uint256 amount,
		address token
	) external whenNotAccountingPaused onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		PledgeFacetImpl.acceptPledgeWithdraw(user, amount, token);
		emit PledgeWithdrawApproved(user, token, amount);
	}

	/// @notice Apply a solver penalty against a user's pledge.
	/// @param user Penalized user.
	/// @param token Token to deduct.
	/// @param amount Penalty amount.
	/// @param recipient Address receiving the penalty funds.
	function slashPledge(
		address user,
		address token,
		uint256 amount,
		address recipient
	) external whenNotAccountingPaused onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		PledgeFacetImpl.slashPledge(user, token, amount, recipient);
		emit UserSlashed(user, token, amount, recipient);
	}
}
