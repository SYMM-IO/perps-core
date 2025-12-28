// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IAccountHub } from "./IAccountHub.sol";

interface IAccountManager {
	event AddAccount(address indexed user, address indexed account, string name);

	function getAccountHub() external view returns (address);

	function getAccounts(address user, uint256 start, uint256 size) external view returns (IAccountHub.Account[] memory);

	function getAccountsLength(address user) external view returns (uint256);
}
