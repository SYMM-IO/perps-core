// SPDX-License-Identifier: SYMM-Core-Business-Source-License-1.1
// This contract is licensed under the SYMM Core Business Source License 1.1
// Copyright (c) 2023 Symmetry Labs AG
// For more information, see https://docs.symm.io/legal-disclaimer/license
pragma solidity >=0.8.18;

interface ISymmioHookEvents {
	event WithdrawAccepted(address indexed user, uint256 indexed requestId, uint8 optionType);
	event WithdrawProcessed(address indexed user, uint256 indexed requestId);
	event WithdrawFinalized(address indexed user, uint256 indexed requestId);
	event WithdrawCancelled(address indexed user, uint256 indexed requestId);
	event WithdrawSuspended(address indexed user, uint256 indexed requestId);
}
