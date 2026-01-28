// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawRequest } from "../storages/WithdrawStorage.sol";
import { ExternalTransferReq } from "../storages/AccountStorage.sol";

interface IVirtualProvider {
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest) external;
	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;
	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;
	function onForceWithdrawCancel(WithdrawRequest memory withdrawRequest) external;
	function onSpeedUpWithdrawRequest(WithdrawRequest memory withdrawRequest, uint256 newCooldown) external;
	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;
	function onExternalTransfer(ExternalTransferReq memory externalTransfer) external;
	function onCancelExternalTransfer(uint256 id) external;
	function onExpressDeposit(address user, uint256 amount, address symmioCore) external;
}
