// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IAssuranceFacet } from "./IAssuranceFacet.sol";
import { AssuranceFacetImpl } from "./AssuranceFacetImpl.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";
import { LibAccessibility } from "../../libraries/LibAccessibility.sol";

contract AssuranceFacet is Accessibility, Pausable, IAssuranceFacet {
	/// @notice Deposit assurance collateral (PartyB-only) used to enable Assurance.
	/// @param token ERC20 token to deposit (token decimals, not normalized).
	/// @param amount Amount to deposit.
	function depositAssuranceCollateral(address token, uint256 amount) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		AssuranceFacetImpl.depositAssuranceCollateral(amount, token);
		emit AssuranceCollateralDeposited(signer, token, amount);
	}

	/// @notice Request to withdraw assurance collateral to a specific recipient.
	/// @param token ERC20 token to withdraw.
	/// @param amount Amount to withdraw.
	/// @param recipient Address receiving the withdrawal if approved.
	function requestAssuranceWithdraw(
		address token,
		uint256 amount,
		address recipient
	) external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		AssuranceFacetImpl.requestAssuranceWithdraw(amount, token, recipient);
		emit AssuranceWithdrawRequested(LibSigner.getSigner(), token, amount, recipient);
	}

	/// @notice Cancel a pending assurance withdrawal request.
	function cancelAssuranceWithdraw() external whenNotAccountingPaused notSuspended(LibSigner.getSigner()) {
		(address token, uint256 amount) = AssuranceFacetImpl.cancelAssuranceWithdraw();
		emit AssuranceWithdrawCancelled(LibSigner.getSigner(), token, amount);
	}

	/// @notice Approve a pending assurance withdrawal and transfer funds to the requested recipient.
	/// @param user User whose request is being approved.
	/// @param amount Amount to withdraw.
	/// @param token ERC20 token to withdraw.
	function acceptAssuranceWithdraw(
		address user,
		uint256 amount,
		address token
	) external whenNotAccountingPaused onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		AssuranceFacetImpl.acceptAssuranceWithdraw(user, amount, token);
		emit AssuranceWithdrawApproved(user, token, amount);
	}

	/// @notice Apply a solver penalty against a user's assurance collateral.
	/// @param user Penalized user.
	/// @param token Token to deduct.
	/// @param amount Penalty amount.
	/// @param recipient Address receiving the penalty funds.
	function slashUser(
		address user,
		address token,
		uint256 amount,
		address recipient
	) external whenNotAccountingPaused onlyRole(LibAccessibility.PARTY_B_MANAGER_ROLE) {
		AssuranceFacetImpl.slashUser(user, token, amount, recipient);
		emit UserSlashed(user, token, amount, recipient);
	}
}
