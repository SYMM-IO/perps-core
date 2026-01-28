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
	/**
	 * @notice Transfers collateral from sender's available balance to whitelisted target without any cooldown
	 * @dev sender must not be suspended/liquidated for the operation to succeed
	 * @param receiver The address of the recipient user in the target contract
	 * @param amount The amount to transfer, specified in collateral decimals
	 * @param target The address of the target contract that will receive the collateral
	 */
	function externalTransfer(
		address receiver,
		uint256 amount,
		address target
	) external whenNotExternalTransferPaused notSuspended(LibSigner.getSigner()) notLiquidatedPartyA(LibSigner.getSigner()) {
		address signer = LibSigner.getSigner();
		ExternalTransferFacetImpl.externalTransfer(signer, receiver, amount, target);
		emit ExternalTransfer(signer, receiver, amount, target);
	}

	/**
	 * @notice Transfers virtual collateral fund from sender's available balance in this Symmio Diamond to another Symmio Diamond
	 * @dev sender must not be suspended/liquidated for the operation to succeed
	 * @param receiver The address of the recipient user in the target contract
	 * @param amount The amount to transfer, specified in collateral decimals
	 * @param target The target Symmio contract
	 * @param virtualProvider The provider who can virtualDeposit fund to target Symmio contract
	 */
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

	/**
	 * @notice Accepts a virtual external transfer that was previously initiated
	 * @dev Can be called by the receiver of the virtual external transfer when not paused
	 * @param id The ID of the virtual external transfer to accept
	 */
	function acceptVirtualExternalTransfer(uint256 id) external whenNotExternalTransferPaused {
		ExternalTransferFacetImpl.acceptVirtualExternalTransfer(id);
		emit AcceptVirtualExternalTransfer(id);
	}

	/**
	 * @notice Cancels a previously initiated virtual external transfer.
	 * @dev Delegates cancellation logic to ExternalTransferFacetImpl.cancelVirtualExternalTransfer(id).
	 *      Emits {CancelVirtualExternalTransfer}. Callable only when external transfers are not paused;
	 *      reverts if the transfer does not exist or the caller is not authorized per implementation rules.
	 * @param id The identifier of the virtual external transfer to cancel.
	 */
	function cancelVirtualExternalTransfer(uint256 id) external notSuspended(LibSigner.getSigner()) whenNotExternalTransferPaused {
		ExternalTransferFacetImpl.cancelVirtualExternalTransfer(id);
		emit CancelVirtualExternalTransfer(id);
	}
}
