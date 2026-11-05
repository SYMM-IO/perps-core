// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

interface IOperatorEvents {
	event WithdrawProcessed(address indexed user, uint256 indexed requestId);
	event WithdrawLocked(address indexed user, uint256 indexed requestId);
	event WithdrawUnlockedAndProcessed(address indexed user, uint256 indexed requestId);
}

interface IOperatorFacet is IOperatorEvents {
	function processWithdraw(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external;

	function lockWithdraw(address user, uint256 requestId) external;

	function unlockAndProcess(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external;
}
