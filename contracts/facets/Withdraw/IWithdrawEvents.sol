// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

import { WithdrawReceiverPart } from "../../storages/WithdrawStorage.sol";

interface IWithdrawEvents {
	event WithdrawInitiated(uint256 indexed requestId, address indexed user, WithdrawReceiverPart[] parts, bool speedUp, bytes providerData);

	event WithdrawAccepted(uint256 indexed requestId, address indexed user);

	event WithdrawFinalized(uint256 indexed requestId, address indexed user);

	event WithdrawCancelRequested(uint256 indexed requestId, address indexed user);

	event WithdrawCancelled(uint256 indexed requestId, address indexed user);

	event Withdraw(address sender, address user, uint256 amount);

	event WithdrawSuspended(uint256 requestId,address user);

	event WithdrawRejected(uint256 requestId,address user);

	event WithdrawSpeedUpAccepted(uint256 requestId, address user, uint256 newCooldown);
}
