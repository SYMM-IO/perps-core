// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawRequest } from "../../../core/storages/WithdrawStorage.sol";

interface ISymmioHookEvents {
	event WithdrawAccepted(address indexed user, uint256 indexed requestId, uint8 optionType);
	event WithdrawProcessed(address indexed user, uint256 indexed requestId);
	event WithdrawFinalized(address indexed user, uint256 indexed requestId);
	event WithdrawCancelled(address indexed user, uint256 indexed requestId);
	event WithdrawSuspended(address indexed user, uint256 indexed requestId);
	event SponsorCoverageRestored(address indexed user, uint256 indexed requestId, address indexed affiliate, uint256 restored, uint256 shortfall);
	event GeneralBadDebtAccrued(address indexed user, uint256 indexed requestId, uint256 amount);
}

interface ISymmioHookFacet is ISymmioHookEvents {
	function onWithdrawRequest(WithdrawRequest memory withdrawRequest, address) external;

	function onWithdrawComplete(WithdrawRequest memory withdrawRequest) external;

	function onWithdrawCancelRequest(WithdrawRequest memory withdrawRequest) external;

	function onWithdrawSuspend(WithdrawRequest memory withdrawRequest) external;
}
