// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import "./IWithdrawEvents.sol";
import "../../storages/WithdrawStorage.sol";

interface IWithdrawFacet is IWithdrawEvents {
	function initiateWithdraw(WithdrawReceiverPart[] memory parts, bytes memory data) external;
	function acceptWithdrawRequest(address user, uint256 requestId) external;
	function finalizeWithdrawRequest(address user, uint256 requestId) external;
	function requestCancelWithdraw(uint256 requestId) external;
	function forceCancelWithdraw(uint256 requestId) external;
	function acceptWithdrawCancelRequest(address user, uint256 requestId) external;
}
