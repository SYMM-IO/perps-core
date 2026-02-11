// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { VirtualAccountIsolationType } from "../../storages/AccountHubStorage.sol";
import { ISymmio } from "../../interfaces/ISymmio.sol";
import { IAccountLayerErrors } from "../../interfaces/IAccountLayerErrors.sol";

/// @notice Events emitted by the MarginFacet
interface IMarginFacetEvents {
	/// @notice Emitted when margin is added to a virtual account from its parent
	event AddMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
	/// @notice Emitted when margin is removed from a virtual account back to its parent
	event RemoveMargin(address indexed virtualAccount, address indexed subAccount, uint256 amount);
	/// @notice Emitted when funds are recovered from a lost virtual account address
	event EmergencyMarginRecovered(address indexed virtualAccount, address indexed subAccount, uint256 amount);
}

/// @notice Interface for transferring margin between sub-accounts and virtual accounts
interface IMarginFacet is IMarginFacetEvents, IAccountLayerErrors {
	/// @notice Transfers allocated margin from a parent sub-account to a virtual account
	/// @param virtualAccount The virtual account to add margin to
	/// @param amount The amount to transfer
	function addMargin(address virtualAccount, uint256 amount) external;

	/// @notice Pre-funds the next virtual account that will be created for a given isolation key
	/// @param subAccount The parent sub-account
	/// @param isolationType The isolation type for the target VA
	/// @param symbolId The symbol ID for the target VA
	/// @param amount The amount to transfer
	function addMarginToNextVA(address subAccount, VirtualAccountIsolationType isolationType, uint256 symbolId, uint256 amount) external;

	/// @notice Deallocates and transfers margin from a virtual account back to its parent
	/// @param virtualAccount The virtual account to remove margin from
	/// @param amount The amount to deallocate and transfer
	/// @param upnlSig The Muon signature proving the account's unrealized PnL
	function removeMargin(address virtualAccount, uint256 amount, ISymmio.SingleUpnlSig memory upnlSig) external;

	/// @notice Recovers funds from a lost virtual account address back to its parent
	/// @param subAccount The parent sub-account to recover funds to
	/// @param nonce The nonce used to derive the lost virtual account address
	function emergencyRecoverMargin(address subAccount, uint256 nonce) external;
}
