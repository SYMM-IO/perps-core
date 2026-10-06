// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

/// @notice Minimal interface for OpenZeppelin's ProxyAdmin, used by upgrade tasks
interface IProxyAdmin {
	function upgrade(address proxy, address implementation) external;
	function upgradeAndCall(address proxy, address implementation, bytes calldata data) external payable;
}
