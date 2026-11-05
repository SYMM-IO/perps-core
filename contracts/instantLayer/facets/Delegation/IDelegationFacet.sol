// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { Account, DelegationInfo, SignedDelegation } from "../../InstantLayerTypes.sol";
import { IInstantLayerErrors } from "../../interfaces/IInstantLayerErrors.sol";
import { IInstantLayerEvents } from "../../interfaces/IInstantLayerEvents.sol";

/// @notice Delegation lifecycle for the InstantLayer diamond: grant, sign-and-grant, and the
///         two-step (schedule, then finalize) revoke.
interface IDelegationFacet is IInstantLayerEvents, IInstantLayerErrors {
	/// @notice Grant delegation permissions directly (no signature required).
	/// @dev Caller must be the account owner.
	/// @param info Delegation information including delegate address and permissions
	function grantDelegation(DelegationInfo calldata info) external;

	/// @notice Grant delegation to several delegates of one account in a single call.
	/// @dev Caller must own the account. Every entry must name the same PartyA account.
	/// @param infos Delegation entries, each with its own delegate, selectors and expiry
	function grantDelegations(DelegationInfo[] calldata infos) external;

	/// @notice Grant batch delegation permissions using a signature.
	/// @dev Allows account owners to delegate multiple function selectors to another address
	///      via an off-chain signature. This enables gasless delegation setup.
	/// @param signedDelegation Delegation details including permissions and anti-replay parameters
	/// @param signature        EIP-712 signature from the account owner
	function grantBatchDelegationBySig(SignedDelegation calldata signedDelegation, bytes calldata signature) external;

	/// @notice Schedule revocation of specific selectors; takes effect after the cooldown.
	/// @dev Who may schedule: account owner (delegator), the delegate themselves, or REVOKER_ROLE.
	///      No-ops for selectors not currently active.
	function initiateRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external;

	/// @notice Finalizes a scheduled revocation after cooldown by deleting the delegation.
	/// @dev Anyone may call once the ETA has passed.
	function finalizeRevokeDelegation(Account calldata account, address delegate, bytes4[] calldata selectors) external;
}
