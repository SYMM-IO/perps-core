// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Getters shared by the legacy monolith and the InstantLayer diamond.
interface IInstantLayerDelegationSource {
	function symmio() external view returns (address);
	function accountLayer() external view returns (address);
	function delegations(address delegator, address delegate, bytes4 selector) external view returns (uint256);
	function pendingRevocationEta(address delegator, address delegate, bytes4 selector) external view returns (uint256);
}
