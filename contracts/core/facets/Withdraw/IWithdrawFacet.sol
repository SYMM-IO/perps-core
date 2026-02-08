// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { IWithdrawEvents } from "./IWithdrawEvents.sol";
import { WithdrawReceiverPart } from "../../storages/WithdrawStorage.sol";

interface IWithdrawFacet is IWithdrawEvents {
	function initiateWithdraw(WithdrawReceiverPart[] memory parts,bool speedUp, bytes memory data) external returns (uint256 requestId);
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function finalizeWithdrawRequest(address user, uint256 requestId) external;
	function requestCancelWithdraw(uint256 requestId) external;
	function forceCancelWithdraw(address user, uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
	function suspendWithdrawRequest(address user, uint256 requestId) external;
	function acceptSpeedUpRequest(address user, uint256 requestId, uint256 newCooldown) external;
}
