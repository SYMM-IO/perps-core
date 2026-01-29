// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IBindingFacet } from "./IBindingFacet.sol";
import { BindingFacetImpl } from "./BindingFacetImpl.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

contract BindingFacet is Accessibility, Pausable, IBindingFacet {
	/// @notice Allows Party A to bind to Party B
	/// @dev Can only be called by Party A when not suspended
	/// @param partyB The address of Party B
	function bindToPartyB(address partyB) external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		BindingFacetImpl.bindToPartyB(partyB);
		emit BindToPartyB(partyB, LibSigner.getSigner());
	}

	/// @notice Allows Party A to request to unbind from Party B
	/// @dev Can only be called by Party A when not suspended
	function requestToUnbindFromPartyB() external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		BindingFacetImpl.requestToUnbindFromPartyB();
		emit RequestToUnbindFromPartyB(LibSigner.getSigner());
	}

	/// @notice Allows Party A to cancel the unbind request from Party B
	/// @dev Can only be called by Party A when not suspended
	function cancelUnbindRequest() external notSuspended(LibSigner.getSigner()) userNotPartyB(LibSigner.getSigner()) {
		BindingFacetImpl.cancelUnbindRequest();
		emit CancelUnbindRequest(LibSigner.getSigner());
	}

	/// @notice Allows Party B to complete the unbind request from Party A
	/// @dev Can be called by PartyA after cooldown or partyB right away
	/// @param partyA The address of Party A
	function completeUnbindRequest(address partyA) external notSuspended(LibSigner.getSigner()) {
		BindingFacetImpl.completeUnbindRequest(partyA);
		emit CompleteUnbindRequest(partyA, LibSigner.getSigner());
	}

	/**
	 * @notice Enables the instant action mode for a PartyA
	 * @dev Only callable by PartyA accounts, not PartyB
	 */
	function activateInstantActionMode()
		external
		userNotPartyB(LibSigner.getSigner())
		whenInstantModeIsNotActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
	{
		BindingFacetImpl.activateInstantActionMode();
		emit ActivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}

	/**
	 * @notice Initiates the process to deactivate instant action mode
	 * @dev Only callable by PartyA accounts, starts a time-delayed process
	 */
	function proposeToDeactivateInstantActionMode()
		external
		userNotPartyB(LibSigner.getSigner())
		whenInstantModeIsActive(LibSigner.getSigner())
		whenNotPartyAActionsPaused
	{
		BindingFacetImpl.proposeToDeactivateInstantActionMode();
		emit ProposeToDeactivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}

	/**
	 * @notice Completes the deactivation of instant action mode after proposal
	 * @dev Only callable by PartyA accounts after the waiting period has passed
	 */
	function deactivateInstantActionMode() external userNotPartyB(LibSigner.getSigner()) whenNotPartyAActionsPaused {
		BindingFacetImpl.deactivateInstantActionMode();
		emit DeactivateInstantActionMode(LibSigner.getSigner(), block.timestamp);
	}
}
