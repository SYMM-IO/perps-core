// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Accessibility } from "../../utils/Accessibility.sol";
import { Pausable } from "../../utils/Pausable.sol";
import { IExternalTransferFacet } from "./IExternalTransferFacet.sol";
import { ExternalTransferFacetImpl } from "./ExternalTransferFacetImpl.sol";
import { LibSigner } from "../../libraries/LibSigner.sol";

contract ExternalTransferFacet is Accessibility, Pausable, IExternalTransferFacet {
	/// @notice Transfers collateral from sender's available balance to a whitelisted target via a relayer, without any cooldown.
	/// @dev The target can be another Symmio diamond or any trusted external contract. Symmio only requires that
	///      the target has an authorized relayer registered via addRelayerForExternalTransferTarget.
	/// @param receiver The address of the recipient in the target contract.
	/// @param amount The amount to transfer, specified in collateral decimals.
	/// @param target The address of the target contract that will receive the collateral.
	function externalTransfer(
		address receiver,
		uint256 amount,
		address target
	) external whenNotExternalTransferPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		ExternalTransferFacetImpl.externalTransfer(signer, receiver, amount, target);
		emit ExternalTransfer(signer, receiver, amount, target);
	}

	/// @notice Initiates a virtual external transfer by deducting the sender's balance and notifying the virtual provider.
	/// @dev Uses a virtual provider as intermediary for transfers that don't move actual tokens (e.g., cross-chain).
	///      The provider receives an onExternalTransfer callback and must later call acceptVirtualExternalTransfer
	///      to complete the transfer. Until accepted, the sender can cancel and reclaim their balance.
	/// @param receiver The address of the recipient in the target contract.
	/// @param amount The amount to transfer, specified in collateral decimals.
	/// @param target The target contract.
	/// @param virtualProvider The provider who handles the virtual deposit on the target contract.
	function virtualExternalTransfer(
		address receiver,
		uint256 amount,
		address target,
		address virtualProvider
	) external whenNotExternalTransferPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		uint256 id = ExternalTransferFacetImpl.virtualExternalTransfer(signer, receiver, amount, target, virtualProvider);
		emit InitiateVirtualExternalTransfer(id, signer, receiver, amount, target, virtualProvider);
	}

	/// @notice Accepts a virtual external transfer that was previously initiated.
	/// @param id The ID of the virtual external transfer to accept.
	function acceptVirtualExternalTransfer(uint256 id) external whenNotExternalTransferPaused {
		ExternalTransferFacetImpl.acceptVirtualExternalTransfer(id);
		emit AcceptVirtualExternalTransfer(id);
	}

	/// @notice Cancels a previously initiated virtual external transfer and refunds the sender's balance.
	/// @param id The identifier of the virtual external transfer to cancel.
	function cancelVirtualExternalTransfer(uint256 id) external notSuspended(LibSigner.getSigner()) whenNotExternalTransferPaused {
		ExternalTransferFacetImpl.cancelVirtualExternalTransfer(id);
		emit CancelVirtualExternalTransfer(id);
	}
}
