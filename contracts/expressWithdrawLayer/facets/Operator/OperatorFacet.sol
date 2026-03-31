// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../../core/storages/WithdrawStorage.sol";

import { IOperatorFacet } from "./IOperatorFacet.sol";
import { OperatorFacetImpl } from "./OperatorFacetImpl.sol";

import { LibErrors } from "../../libraries/LibErrors.sol";

import { GlobalStorage } from "../../storages/GlobalStorage.sol";

/// @title OperatorFacet
/// @notice Bot/operator functions for processing, locking, and unlocking withdrawals.
contract OperatorFacet is IOperatorFacet {
	modifier nonReentrant() {
		GlobalStorage.Layout storage s = GlobalStorage.layout();
		if (s.reentrancyStatus == 1) revert LibErrors.Reentrancy();
		s.reentrancyStatus = 1;
		_;
		s.reentrancyStatus = 0;
	}

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
