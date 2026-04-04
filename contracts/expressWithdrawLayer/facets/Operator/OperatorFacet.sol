// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

import { IOperatorFacet } from "./IOperatorFacet.sol";
import { OperatorFacetImpl } from "./OperatorFacetImpl.sol";

import { ReentrancyGuard } from "../../utils/ReentrancyGuard.sol";

/// @title OperatorFacet
/// @notice Bot/operator functions for processing, locking, and unlocking withdrawals.
contract OperatorFacet is IOperatorFacet, ReentrancyGuard {
	function processWithdraw(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant {
		OperatorFacetImpl.processWithdraw(user, requestId, parts);
		emit WithdrawProcessed(user, requestId);
	}

	function lockWithdraw(address user, uint256 requestId) external nonReentrant {
		OperatorFacetImpl.lockWithdraw(user, requestId);
		emit WithdrawLocked(user, requestId);
	}

	function unlockAndProcess(address user, uint256 requestId, WithdrawReceiverPart[] calldata parts) external nonReentrant {
		OperatorFacetImpl.unlockAndProcess(user, requestId, parts);
		emit WithdrawUnlockedAndProcessed(user, requestId);
	}
}
