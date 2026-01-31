// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface IAccountHubHook {
	function onAccountCreation(address user, address subAccount, bytes memory metadata) external returns (bool);
	function onVirtualAccountCreation(address virtualAccount, address parent, bytes memory metadata) external returns (bool);
	function onVirtualAccountDeletion(address account) external;
	function onSubAccountDeletion(address subAccount, address owner) external;
	function onCall(address account, bytes[] memory callDatas) external;
}
