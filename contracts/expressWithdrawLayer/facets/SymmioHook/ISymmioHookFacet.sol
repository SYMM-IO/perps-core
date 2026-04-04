// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { ISymmioHookEvents } from "./ISymmioHookEvents.sol";
import { WithdrawRequest } from "../../../core/storages/WithdrawStorage.sol";

interface ISymmioHookFacet is ISymmioHookEvents {
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address) external;

	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;

	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;
}
